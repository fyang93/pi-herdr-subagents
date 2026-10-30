/**
 * Agent profiles: discovery of `.md` definitions (global, then project), their frontmatter,
 * the model name each resolves to, and the tool allowlist a child runs with.
 */
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string | string[];
  skills?: string;
  thinking?: string;
  /**
   * A non-empty list grants this agent the subagent spawning toolset and limits
   * it to spawning the listed agents — this, not the `tools` list, grants
   * spawning. Enforced in the child via the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * Added to explicit tool allowlists when `subagent_agents` grants delegation.
 * Spawn targets are independently restricted by PI_SUBAGENT_ALLOWED.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
] as const;

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session); an empty set denies delegation.
 */
export const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (raw === undefined) return process.env.PI_SUBAGENT_AGENT ? new Set<string>() : null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
})();

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** `value` when it is one of `allowed`, else undefined. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** A project's `.env` variables, read for lookups only: loading them would leak into every command pi runs. */
function projectEnv(cwd: string): Record<string, string | undefined> {
  try { return parseEnv(readFileSync(join(cwd, ".env"), "utf8")); } catch { return {}; }
}

/** Expand `${NAME}` from the environment, else from the project's `.env`. */
export function resolveModelEnv(model: string | undefined, cwd = process.cwd()): string | undefined {
  let dotenv: Record<string, string | undefined> | undefined;
  return model?.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = process.env[name] ?? (dotenv ??= projectEnv(cwd))[name];
    if (value == null || !value.trim()) throw new Error(`Subagent model references unset environment variable: ${name}`);
    return value.trim();
  });
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  // Only files that open with frontmatter are agents; a README.md beside them is not.
  if (!/^---\r?\n/.test(content)) return null;
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return null;
  }
  const { frontmatter, body } = parsed;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return null;
  const field = (key: string): string | undefined =>
    frontmatter[key] == null ? undefined : String(frontmatter[key]).trim();
  return {
    name: field("name") ?? fallbackName,
    description: field("description"),
    model: field("model"),
    tools: Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String) : field("tools"),
    systemPromptMode: oneOf(field("system-prompt"), ["append", "replace"] as const),
    skills: field("skill") ?? (typeof frontmatter.skills === "boolean" ? undefined : field("skills")),
    thinking: field("thinking"),
    subagentAgents: parseCommaList(field("subagent_agents")),
    autoExit: parseOptionalBoolean(frontmatter["auto-exit"]),
    interactive: parseOptionalBoolean(frontmatter.interactive),
    sessionMode: oneOf(field("session-mode"), ["standalone", "lineage-only", "fork"] as const),
    cwd: field("cwd"),
    body: body.trim() || undefined,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

export function discoverAgentDefinitions(cwd = process.cwd()): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: join(getAgentDir(), "agents"), source: "global" },
    { path: join(cwd, ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      let content: string;
      try { content = readFileSync(join(dir, file), "utf8"); } catch { continue; } // e.g. a dangling link
      const parsed = parseAgentDefinition(content, file.replace(/\.md$/, ""));
      if (parsed) agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

// Same lookup as subagents_list: by declared name, project > global > package.
export function loadAgentDefaults(agentName: string, cwd?: string): AgentDefaults | null {
  return discoverAgentDefinitions(cwd).find((agent) => agent.name === agentName) ?? null;
}

const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/** Preserve Pi's allowlist or relative selector, enabling required child tools in the same mode. */
export function buildSubagentToolAllowlist(
  effectiveTools?: string | string[],
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (Array.isArray(effectiveTools) ? effectiveTools : [effectiveTools ?? ""])
    .flatMap((value) => value.trim().split(/[\s,]+/))
    .filter(Boolean);
  if (requested.length === 0) return null;

  const relative = requested.every((tool) => /^[+-]/.test(tool));
  if (!relative && requested.some((tool) => /^[+-]/.test(tool))) {
    throw new Error("tools must use either plain names or only +name/-name selectors, not both.");
  }
  for (const tool of requested) {
    if (!(relative ? /^[+-][a-zA-Z0-9_-]+$/ : /^[a-zA-Z0-9_*-]+$/).test(tool)) {
      throw new Error(`Invalid tool selector: ${tool}`);
    }
  }

  const required = [...SUBAGENT_CONTROL_TOOLS, ...(opts?.grantSpawning ? SPAWNING_TOOLS : [])];
  // Keep relative selectors ordered: Pi applies them left-to-right, so a Set
  // would incorrectly collapse sequences such as -bash,+bash,-bash.
  const allow = requested.filter((tool) => !relative || !required.some((name) => tool === `-${name}`));
  for (const tool of required) {
    const selector = relative ? `+${tool}` : tool;
    if (!allow.includes(selector)) allow.push(selector);
  }
  return allow.join(",");
}

export const NO_AGENTS = "No subagent definitions found. Add profiles to .pi/agents/ or your Pi config's agents/ directory; see examples/agents/ in this package.";
