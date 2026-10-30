import type { ExtensionAPI, ExtensionContext, FileEntry, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir, keyHint, parseFrontmatter, parseSessionEntries, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Box, Text, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  isHerdrAvailable,
  herdrSetupHint,
  ensurePiIntegration,
  piIntegrationPath,
  startAgent,
  findSessionAgent,
  type AgentLaunch,
  waitForExit,
  closePane,
} from "./herdr.ts";

import {
  currentTool,
  getSessionId,
  readNameRegistry,
  pendingQuestions,
  removeConsumedFile,
  publishInboxMessage,
  readSubagentLoadout,
  registerName,
  registryEntry,
  seedSubagentSessionFile,
  summarizeSessionStats,
  writeSubagentLoadout,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const launchDeps = { startAgent, findSessionAgent, watchSubagent };

// Survive /reload: abort watchers from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
// Running subagents handed from the old module load to the new one across /reload.
const RELOAD_HANDOFF_KEY = Symbol.for("pi-subagents/reload-handoff");

{
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Agent profile to spawn, e.g. worker, scout or researcher (subagents_list shows all).",
  }),
  task: Type.String({ description: "Task for the subagent." }),
  name: Type.Optional(
    Type.String({
      description:
        "Display name; defaults to the agent name.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Override the agent's default model." })),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the subagent.",
    }),
  ),
});

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

interface AgentDefinition extends AgentDefaults {
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
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
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
function resolveModelEnv(model: string | undefined, cwd = process.cwd()): string | undefined {
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

function discoverAgentDefinitions(cwd = process.cwd()): ListedAgentDefinition[] {
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

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  return sessionDir;
}

// Same lookup as subagents_list: by declared name, project > global > package.
function loadAgentDefaults(agentName: string, cwd?: string): AgentDefaults | null {
  return discoverAgentDefinitions(cwd).find((agent) => agent.name === agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

const fail = (text: string, error = text) => ({
  content: [{ type: "text" as const, text }], details: { error }, isError: true,
});

const NO_AGENTS = "No subagent definitions found. Add profiles to .pi/agents/ or your Pi config's agents/ directory; see examples/agents/ in this package.";

function herdrUnavailableResult() {
  return fail(`Subagents require herdr. ${herdrSetupHint()}`, "herdr not available");
}

/** The session's artifact directory, which holds its subagents' name registry: `<sessionDir>/artifacts/<session-id>/`. */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Watch a running subagent in the background and steer its result into the parent. */
function watchAndDeliver(running: RunningSubagent): void {
  const pi = latestPi;
  if (!pi) return;
  const { signal } = running.abortController = new AbortController();
  const lifecycle = getModuleAbortSignal();
  // Reload hands delivery to the new watcher; shutdown must not start a turn on a stale pi.
  const silenced = () => running.handedOff || signal.aborted || lifecycle.aborted;
  refreshWidget();
  unconsumed.add(running.id);
  const watching = running.watching = track(launchDeps.watchSubagent(running, signal));
  // watchSubagent reports its own failures as results; it does not reject.
  void watching
    .then((result) => {
      if (silenced()) return unconsumed.delete(running.id);
      sendTracked(pi, running.id, {
        customType: "subagent_result", content: resolveResultPresentation(result, running.name), display: true,
        details: {
          id: running.id, name: running.name, task: running.task, agent: running.agent, exitCode: result.exitCode,
          elapsed: result.elapsed, summary: result.summary, sessionFile: result.sessionFile,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.endedEarly ? { endedEarly: true } : {}),
          ...(result.stats ? { stats: result.stats } : {}),
        },
      });
    })
    // A pi or ctx made stale by a session switch throws; there is no one left to tell.
    .catch(() => { unconsumed.delete(running.id); })
    .finally(() => { try { refreshWidget(); } catch {} });
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage" | "endedEarly"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const sessionRef = `\n\nIf more work is needed, follow up with subagent_message({ name: ${JSON.stringify(name)}, message: "…" }); no reply is needed otherwise.`;

  if (result.errorMessage) {
    // A provider or agent-loop error, or an answer cut off at the output limit: surface it so the
    // orchestrator can retry, resume or change approach, with whatever the run did produce, which
    // only this text carries to its model.
    const partial = result.summary && !result.summary.startsWith("Subagent error:")
      ? `\n\nPartial answer — not a completed result:\n\n${result.summary}`
      : "\n\nThe subagent did not produce a result.";
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)}.\n\n` +
      `Error: ${result.errorMessage}${partial}\n\n` +
      `You can resume the session with subagent_message, or spawn a new subagent.${sessionRef}`
    );
  }

  if (result.endedEarly) {
    return `Sub-agent "${name}" was ended in its pane before it finished (${formatElapsed(result.elapsed)}); ` +
      `its last message may be partial.\n\n${result.summary}${sessionRef}`;
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  /** Why the run failed: a provider or agent-loop error, or an answer cut off at the output limit. */
  errorMessage?: string;
  /** Someone ended an autonomous subagent in its pane before it finished. */
  endedEarly?: boolean;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  /** herdr pane hosting the agent, as last seen; it changes if the pane moves. */
  surface: string;
  /** herdr agent name: follows the agent when its pane moves, so it is the supervision handle. */
  herdrName: string;
  startTime: number;
  sessionFile: string;
  abortController?: AbortController;
  /**
   * When true, a blocked agent does not wake the parent: the user drives the
   * conversation in the subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Last herdr status, so a blocked agent is reported once per block. */
  status?: string;
  /** Settles once the watcher has reported the subagent and cleaned up after it. */
  watching?: Promise<unknown>;
  /** Handed to the reloaded extension: leave the pane open and report nothing. */
  handedOff?: boolean;
  /** Delivered question files whose deletion failed; retained across reload without sending twice. */
  questionCleanup?: Set<string>;
  noticeCleanup?: Set<string>;
}

interface ReloadHandoff {
  running: RunningSubagent[];
  held: Array<[string, Parameters<ExtensionAPI["sendMessage"]>[0]]>;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();
// Sessions a pi is being started on, by a launch or a resume: until it is tracked in
// runningSubagents, nothing else may start another pi on the same transcript.
const STARTING_SESSIONS_KEY = Symbol.for("pi-subagents/starting-sessions");
const startingSessions = ((globalThis as any)[STARTING_SESSIONS_KEY] ??= new Set<string>()) as Set<string>;

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
// A child counts until this session has taken in its result, not just until its pane closed:
// the result can arrive as the session settles, and is processed only after that.
const unconsumed = new Set<string>();
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => new Set([...runningSubagents.keys(), ...unconsumed]).size;

/**
 * Results, questions and status notices sent but not yet in the conversation, by delivery id.
 * A queued steer is dropped when the user presses Escape, so these are sent again once that run ends.
 */
const undelivered = new Map<string, Parameters<ExtensionAPI["sendMessage"]>[0]>();

/** Of `undelivered`, those that waited in Pi's queue during the current run. */
const queued = new Set<string>();

/** Latest ExtensionAPI, used to deliver watcher notifications to the parent. */
let latestPi: ExtensionAPI | null = null;
/** Latest UI context, for the running-subagents widget. */
let latestCtx: ExtensionContext | null = null;

// ── Running-subagents widget ──

function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Right-hand label: herdr's state, plus the tool a working pi subagent is in. */
function widgetStatus(running: RunningSubagent, theme: Pick<Theme, "fg">): string {
  const status = running.status ?? "starting";
  if (status === "blocked") return theme.fg("error", status);
  if (status !== "working") return theme.fg("dim", status);
  const tool = currentTool(running.sessionFile);
  return theme.fg("warning", "working") + (tool ? ` · ${tool}` : "");
}

/** One bordered line per running subagent: elapsed, name (agent), state. */
function renderSubagentWidgetLines(agents: RunningSubagent[], width: number, theme: Pick<Theme, "fg">, now = Date.now()): string[] {
  if (width < 4) return [];
  const inner = width - 2;
  const title = `─ Subagents `;
  const info = ` ${agents.length} running ─`;
  const top = title.length + info.length <= inner
    ? `${title}${"─".repeat(inner - title.length - info.length)}${info}`
    : "─".repeat(inner);
  const lines = [theme.fg("accent", `╭${top}╮`)];
  for (const agent of agents) {
    const right = ` ${widgetStatus(agent, theme)} `;
    const left = truncateToWidth(` ${formatClock(now - agent.startTime)}  ${agent.name}${agent.agent ? ` (${agent.agent})` : ""}`,
      Math.max(0, inner - visibleWidth(right)));
    const row = truncateToWidth(left + " ".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right))) + right, inner);
    lines.push(theme.fg("accent", "│") + row + " ".repeat(Math.max(0, inner - visibleWidth(row))) + theme.fg("accent", "│"));
  }
  lines.push(theme.fg("accent", `╰${"─".repeat(inner)}╯`));
  return lines;
}

let requestWidgetRender: (() => void) | undefined;

/** Show the widget while subagents run (redrawn every second), remove it when none are left. */
function refreshWidget(): void {
  const ui = latestCtx?.hasUI ? latestCtx.ui : null;
  if (!ui || runningSubagents.size === 0) {
    if (requestWidgetRender) ui?.setWidget("subagent-status", undefined);
    requestWidgetRender = undefined;
    return;
  }
  if (requestWidgetRender) return requestWidgetRender();
  ui.setWidget("subagent-status", (tui, theme) => {
    // Elapsed times and tool names change between events: redraw once a second.
    const timer = setInterval(() => tui.requestRender(), 1000);
    timer.unref();
    requestWidgetRender = () => tui.requestRender();
    return {
      invalidate() {},
      render: (width: number) => renderSubagentWidgetLines([...runningSubagents.values()], width, theme),
      dispose() {
        clearInterval(timer);
        requestWidgetRender = undefined;
      },
    };
  }, { placement: "aboveEditor" });
}

const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/** Preserve Pi's allowlist or relative selector, enabling required child tools in the same mode. */
function buildSubagentToolAllowlist(
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

/**
 * The APPEND_SYSTEM.md Pi itself would load in `cwd`: the project's, when that folder is
 * recorded as trusted, else the global one.
 */
function discoveredAppendFile(cwd: string, agentDir: string): string | undefined {
  const project = join(cwd, ".pi", "APPEND_SYSTEM.md");
  if (existsSync(project) && new ProjectTrustStore(agentDir).get(cwd) === true) return project;
  const global = join(agentDir, "APPEND_SYSTEM.md");
  return existsSync(global) ? global : undefined;
}

/**
 * Apply a loadout snapshot to pi arguments: identity, optional tool allowlist and the
 * delegation helper. Extensions are discovered normally.
 *
 * Shared by the initial `launchSubagent` and the `subagent_message` resume path.
 * Native resume rebuilds the system prompt and tools from the current flags and
 * patches the session to match, so resume must replay them. Model and thinking
 * are the launch's alone: the session keeps them, including a later switch.
 * Env vars and cwd are the caller's responsibility.
 */
function applyLoadoutToArgs(
  args: string[],
  loadout: Partial<SubagentLoadout>,
  sessionFile: string,
): void {
  if (loadout.identity && loadout.systemPromptMode) {
    // Passed as a file: herdr refuses agent arguments with line breaks. One per session, rewritten on resume.
    const identityFile = `${sessionFile}.identity.md`;
    writeFileSync(identityFile, loadout.identity, { encoding: "utf8", mode: 0o600 });
    if (loadout.systemPromptMode === "replace") {
      args.push("--system-prompt", identityFile);
    } else {
      // --append-system-prompt replaces Pi's APPEND_SYSTEM.md discovery, so pass that file along.
      const discovered = loadout.cwd && loadout.agentDir ? discoveredAppendFile(loadout.cwd, loadout.agentDir) : undefined;
      if (discovered) args.push("--append-system-prompt", discovered);
      args.push("--append-system-prompt", identityFile);
    }
  }

  if (loadout.toolAllowlist) {
    args.push("--tools", loadout.toolAllowlist);
  }

  if (loadout.spawnable?.length) {
    args.push("-e", fileURLToPath(import.meta.url));
  }
}

/**
 * Arguments that load herdr's pi integration into a child. It reports the child's state and
 * session, which supervision and restart recovery rely on — without it a restarted parent
 * could start a second pi on a live session — so a launch without it fails. It is always
 * loaded explicitly, which settings cannot exclude: the child config dir's own copy when it
 * has one (Pi loads a path once), else the one herdr installed in the default config dir.
 */
async function integrationArgs(agentDir: string): Promise<string[]> {
  await integrationReady;
  if (!piIntegrationPath()) await ensurePiIntegration().catch(() => false);
  const integration = piIntegrationPath();
  if (!integration) throw new Error("herdr's pi integration is not installed, and subagents need it to report their sessions. Run `herdr integration install pi`.");
  const own = join(agentDir, "extensions", basename(integration));
  return ["-e", existsSync(own) ? own : integration];
}

function isValidRunName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name.trim() === name && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name);
}

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session: among running subagents and every name in the spawner's
 * registry, which a launch writes before its first await, so parallel spawns
 * see each other. `subagent_message({ name })` then addresses any subagent of
 * this session unambiguously, running or finished.
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
}

/** A message submitted to the child's Pi. */
function steeredResult(running: RunningSubagent) {
  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". ` +
        "It picks this up at its next turn boundary. " +
        "If it exits, its result still arrives as a steer message.",
    }],
    details: { id: running.id, name: running.name, status: "steered" },
  };
}

/**
 * Steer a tracked subagent. One that is finishing — before, or while, the message was sent —
 * cannot take it: it is reported by its watcher first, and null then says: resume it instead.
 * A deleted inbox file means the child submitted the message to Pi.
 */
async function steerLive(running: RunningSubagent, message: string, signal?: AbortSignal) {
  // Escape stops the waiting, never the supervision or an already-published message.
  signal?.throwIfAborted();
  let reported = false;
  void running.watching?.then(() => { reported = true; });
  const finishing = () => !runningSubagents.has(running.id) ||
    [".exit", ".exiting"].some((marker) => existsSync(running.sessionFile + marker));
  if (finishing()) {
    while (!reported) await delay(100, undefined, { signal });
    return null;
  }
  let file: string;
  try { file = publishInboxMessage(running.sessionFile, message); }
  catch (error: any) { return fail(`Failed to deliver message to subagent "${running.name}": ${error?.message ?? String(error)}`); }
  while (existsSync(file)) {
    if (reported) {
      rmSync(file, { force: true });
      return null;
    }
    await delay(100, undefined, { signal });
  }
  return steeredResult(running);
}

// Serialize delivery and resume per transcript, so resume cannot delete another sender's receipt.
const messageQueues = new Map<string, Promise<void>>();

async function messageInOrder<T>(sessionKey: string, signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  const previous = messageQueues.get(sessionKey);
  const pending = track((async () => {
    if (previous) {
      let onAbort!: () => void;
      try {
        await Promise.race([previous, new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    signal.throwIfAborted();
    return send();
  })());
  // A cancelled waiter must not let its successor overtake an earlier active sender.
  const settled = Promise.allSettled([previous, pending]).then(() => {});
  messageQueues.set(sessionKey, settled);
  void settled.then(() => {
    if (messageQueues.get(sessionKey) === settled) messageQueues.delete(sessionKey);
  });
  return pending;
}

/** How long notices wait for the run of a prompt being prepared before they are sent regardless. */
const PREPARE_GRACE = 30_000;

/** Clear the previous run's markers and inbox. */
function clearStaleMarkers(sessionFile: string): void {
  for (const marker of [".exit", ".exiting", ".paused", ".ask", ".inbox"]) rmSync(sessionFile + marker, { recursive: true, force: true });
}

/** A session file's entries, parsed leniently as Pi does; none when it cannot be read. */
function readSession(sessionFile: string): FileEntry[] {
  try { return parseSessionEntries(readFileSync(sessionFile, "utf8")); } catch { return []; }
}

export const __test__ = {
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveModelEnv,
  buildSubagentToolAllowlist,
  applyLoadoutToArgs,
  uniqueRunningName,
  startingSessions,
  launchDeps,
  steerLive,
  deliverPendingQuestion,
  notify,
  resolveResultPresentation,
  watchSubagent,
  watchAndDeliver,
  runningSubagents,
  unconsumed,
  undelivered,
  queued,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  formatUsageSegments,
  renderSubagentWidgetLines,
};

/**
 * Launch a subagent as a named herdr agent in its own pane. Returns a
 * RunningSubagent once it is ready for input — does NOT wait for completion.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: Static<typeof SubagentParams> & { name: string },
  def: AgentDefinition,
  ctx: Pick<ExtensionContext, "sessionManager" | "cwd" | "model">,
  artifactDir: string,
  opts: { signal?: AbortSignal; toolCallId?: string; thinking?: string } = {},
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = randomUUID().slice(0, 8);
  const effectiveModel = params.model ?? resolveModelEnv(def.model, ctx.cwd) ?? (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
  const thinking = def.thinking ?? opts.thinking;
  const interactive = def.interactive ?? !def.autoExit;
  const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : def.cwd ? resolve(getAgentDir(), def.cwd) : ctx.cwd;
  // cwd changes the start directory, not the parent's config/extensions directory.
  // Absolute: the child starts in `cwd`, where a relative config dir would mean another folder.
  const agentDir = resolve(getAgentDir());
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionDir = getDefaultSessionDirFor(cwd, agentDir);

  // Each launch has its own session path, including simultaneous launches.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const subagentSessionFile = join(sessionDir, `${timestamp}_${randomUUID()}.jsonl`);
  // Persist name → session before any await: it reserves the name against parallel spawns,
  // and lets subagent_message({ name }) resume this subagent after it finishes, even after
  // a pi restart. A failed write fails the launch rather than leave an unaddressable child.
  registerName(artifactDir, params.name, { sessionFile: subagentSessionFile });
  // And reserve the session: until the start finishes, a message to this name is refused as still starting.
  const sessionKey = resolve(subagentSessionFile);
  startingSessions.add(sessionKey);
  let surface: string, herdrName: string;
  try {
    const sessionMode = def.sessionMode ?? "standalone";
    if (sessionMode !== "standalone") {
      seedSubagentSessionFile({
        mode: sessionMode,
        parentSessionFile: sessionFile,
        // The active branch, not the file's tail: after /tree that may be an abandoned branch.
        parentBranch: ctx.sessionManager.getBranch(),
        forkPoint: opts.toolCallId,
        childSessionFile: subagentSessionFile,
        childCwd: cwd,
      });
    }

    // Blank sessions need task/summary instructions; forks already inherit the conversation.
    const modeHint = def.autoExit
      ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
      : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
    const summaryInstruction = def.autoExit
      ? "Your FINAL assistant message should summarize what you accomplished."
      : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
    const identity = def.body ?? null;
    const systemPromptMode = def.systemPromptMode;
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = sessionMode === "fork"
      ? `${roleBlock}\n\n${params.task}`.trimStart()
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

    const args = ["--session", subagentSessionFile, "-e", join(SUBAGENTS_DIR, "subagent-done.ts")];
    // Only the first launch picks them: the session keeps them, including a later switch.
    if (effectiveModel) args.push("--model", effectiveModel);
    if (thinking) args.push("--thinking", thinking);
    // Snapshot the loadout so resume preserves identity and tool restrictions.
    const loadout: SubagentLoadout = {
      agent: params.agent,
      toolAllowlist: buildSubagentToolAllowlist(def.tools, { grantSpawning: !!def.subagentAgents?.length }),
      systemPromptMode: systemPromptMode ?? null,
      identity: identityInSystemPrompt ? identity : null,
      spawnable: def.subagentAgents ?? null,
      interactive,
      cwd,
      // Freeze the config dir so resume never follows a parent's later switch.
      agentDir,
    };
    writeSubagentLoadout(subagentSessionFile, loadout);
    applyLoadoutToArgs(args, loadout, subagentSessionFile);
    args.push(...await integrationArgs(agentDir));
    const env = subagentEnv(loadout, { name: params.name, sessionFile: subagentSessionFile, autoExit: !!def.autoExit });
    // The child's helper loads them all with the task: one run, none started on a skill alone.
    if (def.skills) env.PI_SUBAGENT_SKILLS = def.skills;
    clearStaleMarkers(subagentSessionFile);
    ({ surface, agent: herdrName } = await startTracked({ name: params.name, args, env, cwd }, fullTask, opts.signal));
  } finally {
    startingSessions.delete(sessionKey);
  }

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    herdrName,
    startTime,
    sessionFile: subagentSessionFile,
    interactive,
  };
  runningSubagents.set(id, running);
  return running;
}

/** Settles once herdr's pi integration is checked or installed; launches wait for it. */
let integrationReady: Promise<unknown> = Promise.resolve();

/** Subagents whose pane could not be closed, so they may still be working unsupervised. */
const leftOpen: string[] = [];

/** Launches and watchers still running; shutdown waits for them to close their panes. */
const inFlight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  work.finally(() => inFlight.delete(work)).catch(() => {});
  return work;
}

/**
 * Start an agent, then publish its task. A failed publication, shutdown or cancellation
 * closes the pane rather than leave it untracked.
 */
function startTracked(launch: AgentLaunch, message: string, cancel?: AbortSignal): Promise<{ surface: string; agent: string }> {
  return track((async () => {
    const signal = cancel ? AbortSignal.any([getModuleAbortSignal(), cancel]) : getModuleAbortSignal();
    signal.throwIfAborted();
    const started = await launchDeps.startAgent(launch, signal);
    try {
      signal.throwIfAborted();
      publishInboxMessage(launch.env.PI_SUBAGENT_SESSION, message);
    } catch (error) {
      await closePane(started.surface).catch(() => { leftOpen.push(`${launch.name} (herdr pane ${started.surface})`); });
      throw error;
    }
    return started;
  })());
}

/** Identity, config dir and spawn allowlist a subagent pi process sees (launch and resume). */
function subagentEnv(loadout: SubagentLoadout, opts: { name: string; sessionFile: string; autoExit: boolean }): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_ALLOWED: loadout.spawnable?.join(",") ?? "",
    PI_SUBAGENT_NAME: opts.name,
    PI_SUBAGENT_SESSION: opts.sessionFile,
  };
  const agentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (loadout.agent) env.PI_SUBAGENT_AGENT = loadout.agent;
  if (opts.autoExit) env.PI_SUBAGENT_AUTO_EXIT = "1";
  return env;
}

/**
 * Notify the orchestrator of the questions a still-running subagent asked, without
 * ending it. Each subagent has its own `.ask/` and watcher, so parallel questions from
 * several subagents arrive independently. Questions asked since the last tick arrive
 * together; each is removed once delivered, and one asked meanwhile waits for the next tick.
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  const cleanup = running.questionCleanup ??= new Set<string>();
  for (const file of cleanup) removeConsumedFile(file, cleanup);
  const { files, questions } = pendingQuestions(running.sessionFile, cleanup);
  if (files.length === 0) return;
  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const question = questions.join("\n\n");
  const sessionId = getSessionId(running.sessionFile);
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: ${JSON.stringify(name)}, message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;
  const delivered = !question || (latestPi !== null && sendTracked(latestPi, `${running.id}:question:${randomUUID()}`, {
    customType: "subagent_question",
    content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${question}${replyHint}`,
    display: true,
    details: { name, agent: running.agent, question, ...(sessionId ? { sessionId } : {}) },
  }));
  if (delivered) for (const file of files) removeConsumedFile(file, cleanup); // malformed ones too
}

/** Steer a notice into the parent, keeping it until it enters the conversation; false when that pi is stale. */
function sendTracked(pi: ExtensionAPI, deliveryId: string, message: Parameters<ExtensionAPI["sendMessage"]>[0]): boolean {
  const tracked = { ...message, details: { ...(message.details as object), deliveryId } };
  undelivered.set(deliveryId, tracked);
  // While a submitted prompt is prepared Pi still reports idle, and a run started now would
  // make it reject that prompt: hold the notice for the run the prompt starts.
  if (preparing) return held.push([deliveryId, tracked]), true;
  return transmit(pi, deliveryId, tracked);
}

function transmit(pi: ExtensionAPI, deliveryId: string, tracked: Parameters<ExtensionAPI["sendMessage"]>[0]): boolean {
  // Sent while the parent is busy — running, retrying or compacting — it may wait in Pi's
  // queue, which Escape or editing queued input clears. A stale ctx throws: nothing is queued.
  try { if (latestCtx && !latestCtx.isIdle()) queued.add(deliveryId); } catch {}
  try {
    pi.sendMessage(tracked, { triggerTurn: true, deliverAs: "steer" });
    return true;
  } catch {
    undelivered.delete(deliveryId);
    return false;
  }
}

/** Set while a prompt submitted to an idle parent is prepared, until its run starts or a grace period ends. */
let preparing: ReturnType<typeof setTimeout> | undefined;
/** Plain message data survives reload without retaining the old extension API. */
const held: ReloadHandoff["held"] = [];

function releaseHeld(): void {
  clearTimeout(preparing);
  preparing = undefined;
  for (const [id, message] of held.splice(0)) if (latestPi) transmit(latestPi, id, message);
}

/** Steer a status notice into the parent, kept like a result until it is in; false when its pi is gone or stale. */
function notify(message: Parameters<ExtensionAPI["sendMessage"]>[0]): boolean {
  return latestPi !== null && sendTracked(latestPi, randomUUID(), message);
}

/** Steer the notice for a signal file, consuming the file once it is queued; a failed send retries next tick. */
function deliverOnce(file: string, message: Parameters<ExtensionAPI["sendMessage"]>[0], pendingCleanup?: Set<string>): void {
  if (pendingCleanup?.has(file)) {
    try { unlinkSync(file); } catch { if (!existsSync(file)) pendingCleanup.delete(file); }
    if (!existsSync(file)) pendingCleanup.delete(file);
    return;
  }
  if (!notify(message)) return;
  try { unlinkSync(file); }
  catch { pendingCleanup?.add(file); }
}

/** Wake the parent once when a subagent turn is interrupted in its own pane. */
function reportPaused(running: RunningSubagent): void {
  const file = `${running.sessionFile}.paused`;
  const pendingCleanup = running.noticeCleanup ??= new Set<string>();
  if (!existsSync(file) && !pendingCleanup.has(file)) return;
  deliverOnce(file, {
    customType: "subagent_status",
    content: `Sub-agent "${running.name}" had its turn interrupted in herdr pane ${running.surface} and is waiting for input. ` +
      `subagent_message({ name: ${JSON.stringify(running.name)}, message: "…" }) continues it.`,
    display: true,
    details: { line: `${running.name}: interrupted, waiting in pane ${running.surface}` },
  }, pendingCleanup);
}

/**
 * Wake the parent once when herdr sees a subagent stuck at an approval or
 * question dialog, which only someone at its pane can answer. Interactive
 * subagents are driven by the user in their pane and are left alone.
 */
function reportBlocked(running: RunningSubagent, status: string | null): void {
  if (!status || status === running.status) return;
  running.status = status;
  if (status !== "blocked" || running.interactive) return;
  notify({
    customType: "subagent_status",
    content: `Sub-agent "${running.name}" is blocked at a confirmation or question dialog in herdr pane ${running.surface}. Tell the user, or read it with \`herdr pane read ${running.surface}\`.`,
    display: true,
    details: { line: `${running.name}: blocked at a dialog in pane ${running.surface}` },
  });
}

/** Waits for a subagent to exit, extracts its summary and removes its pane and running entry. */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  deps: { wait?: typeof waitForExit; close?: (surface: string) => void | Promise<void> } = {},
): Promise<SubagentResult> {
  const { startTime, sessionFile } = running;
  let preservePane = false;

  try {
    const result = await (deps.wait ?? waitForExit)(running.herdrName, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      onTick(status, pane) {
        if (pane) running.surface = pane;  // the pane may have moved
        try { deliverPendingQuestion(running); }
        catch (error) { console.warn(`Could not read subagent questions for ${running.name}: ${error}`); }
        reportPaused(running);
        // An unanswered poll is not a state change; it must not re-arm the blocked notice.
        reportBlocked(running, status);
      },
    });

    preservePane = result.preservePane === true;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (result.reason === "interrupted") {
      runningSubagents.delete(running.id);
      // The pane may now be an ordinary shell (or reused). Do not close it.
      return { sessionFile, elapsed, exitCode: 1, summary: `Subagent interrupted: ${result.errorMessage}` };
    }

    // The child reports its answer from its active branch, which the file's order does not show.
    const summary = result.summary ??
      (result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0 ? `Sub-agent exited with code ${result.exitCode}` : "Sub-agent exited without output");

    const stats = existsSync(sessionFile) ? summarizeSessionStats(readSession(sessionFile)) : null;
    // A stale context (session replaced meanwhile) throws; the gauge then shows tokens only.
    try { if (stats?.provider && stats.model) stats.contextWindow = latestCtx?.modelRegistry.find(stats.provider, stats.model)?.contextWindow; } catch {}
    const subagentSessionId = getSessionId(sessionFile);

    // A completion receipt does not grant ownership of a pane now hosting another session.
    try {
      if (!preservePane) await closePane(running.surface, deps.close);
    } catch (error) {
      console.warn(`Could not close completed subagent pane ${running.surface}: ${error}`);
      leftOpen.push(`${running.name} (herdr pane ${running.surface})`);
    }
    // Consumed only now, and not once handed off: the reloaded watcher still needs it.
    if (!running.handedOff) for (const marker of [".exit", ".exiting"]) {
      try { rmSync(sessionFile + marker, { force: true }); }
      catch (error) { console.warn(`Could not remove subagent marker ${sessionFile + marker}: ${error}`); }
    }
    runningSubagents.delete(running.id);

    return {
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(result.reason === "quit" ? { endedEarly: true } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    if (!running.handedOff && !preservePane) {
      try { await closePane(running.surface, deps.close); } catch {
        leftOpen.push(`${running.name} (herdr pane ${running.surface})`);
      }
    }
    runningSubagents.delete(running.id);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (signal.aborted) return { summary: "Subagent cancelled.", exitCode: 1, elapsed, sessionFile };
    return { summary: `Subagent error: ${err?.message ?? String(err)}`, exitCode: 1, elapsed };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    // Subagents are new pi processes, so they load herdr's state integration once installed.
    if (isHerdrAvailable()) {
      integrationReady = ensurePiIntegration().then(
        (installed) => installed && ctx.ui.notify("Installed herdr's pi integration; restart this pi session so its session identity is reported.", "info"),
        () => ctx.ui.notify("Could not check/install herdr's pi integration; run `herdr integration install pi` and restart pi sessions.", "warning"),
      ).catch(() => {}); // the session was replaced or reloaded meanwhile: its ctx is stale
    }
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
    // Keep watching what the previous load handed over; a child that finished
    // meanwhile is found by its exit marker on the first check.
    const handoff = (globalThis as any)[RELOAD_HANDOFF_KEY] as ReloadHandoff | undefined;
    delete (globalThis as any)[RELOAD_HANDOFF_KEY];
    if (event.reason === "reload") {
      for (const previous of handoff?.running ?? []) {
        const running: RunningSubagent = { ...previous, handedOff: false };
        runningSubagents.set(running.id, running);
        watchAndDeliver(running);
      }
      for (const [id, message] of handoff?.held ?? []) {
        if (message.customType === "subagent_result") unconsumed.add(id);
        sendTracked(pi, id, message);
      }
    }
  });

  // A prompt submitted while idle is prepared before its run starts (extensions' hooks may take a
  // while); notices wait for that run. If none starts — the input was handled — they go anyway.
  pi.on("input", (event, ctx) => {
    if (ctx.isIdle()) {
      clearTimeout(preparing);
      preparing = setTimeout(releaseHeld, PREPARE_GRACE);
      preparing.unref();
      return;
    }
    // Submitted while idle (no streaming behavior), yet a run started while earlier input
    // handlers prepared it — say a notice's: Pi would reject the prompt. Steer it into that run.
    if (event.streamingBehavior) return;
    const content = event.images?.length ? [{ type: "text" as const, text: event.text }, ...event.images] : event.text;
    pi.sendUserMessage(content, { deliverAs: "steer" });
    return { action: "handled" as const };
  });
  pi.on("agent_start", releaseHeld);

  // A result or question is taken in when its message enters the conversation: starting a run,
  // steered into one, or appended.
  pi.on("message_start", (event) => {
    const deliveryId = (event.message as any)?.details?.deliveryId;
    if ((event.message as any)?.role !== "custom" || typeof deliveryId !== "string") return;
    undelivered.delete(deliveryId);
    unconsumed.delete(deliveryId);
  });
  // A queued notice not taken in by the time the run settles was cleared from Pi's queue: by
  // Escape, or by editing queued input. Send it again — after Escape appended, without starting
  // the turn the user just stopped; otherwise steered, to be taken in as before.
  pi.on("agent_settled", (event) => {
    const dropped = [...queued].filter((deliveryId) => undelivered.has(deliveryId));
    queued.clear();
    for (const deliveryId of dropped) {
      try {
        pi.sendMessage(undelivered.get(deliveryId)!, event.aborted ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" });
      } catch {
        continue;
      }
      if (!event.aborted) continue; // its message_start acknowledges it
      // Appended to the conversation; Pi tells extensions of no message_start for it.
      undelivered.delete(deliveryId);
      unconsumed.delete(deliveryId);
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async (event, ctx) => {
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    // /reload re-imports this module in the same process: hand running subagents
    // to the new load instead of closing their panes.
    if (event.reason === "reload") (globalThis as any)[RELOAD_HANDOFF_KEY] = {
      running: [...runningSubagents.values()], held: held.slice(),
    } satisfies ReloadHandoff;
    for (const agent of runningSubagents.values()) {
      if (event.reason === "reload") agent.handedOff = true;
      agent.abortController?.abort();
    }
    if (moduleAbort) moduleAbort.abort();
    runningSubagents.clear();
    unconsumed.clear(); // none will be delivered here; a reloaded module counts its own
    undelivered.clear();
    queued.clear();
    clearTimeout(preparing);
    preparing = undefined;
    held.length = 0;
    // Let aborted launches and watchers close their panes before pi exits or switches sessions.
    await Promise.allSettled([...inFlight]);
    if (leftOpen.length === 0) return;
    const warning = `Could not close subagent pane(s), which may still be working: ${leftOpen.splice(0).join(", ")}. Close them in herdr.`;
    console.warn(warning);
    try { ctx.ui.notify(warning, "warning"); } catch {}
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the optional `--tools` allowlist;
  // PI_SUBAGENT_ALLOWED independently restricts delegation targets.

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a subagent in its own pane. Fire-and-forget: returns an acknowledgement; " +
        "completion is automatically steered back later and starts a new turn.",
      promptSnippet:
        "After spawning, end your turn or do independent work. Do not wait, poll tools or logs, or invent results.",
      parameters: SubagentParams,

      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return fail(
            `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
            "self-spawn blocked",
          );
        }

        // Require a definition at every depth; discovery also enforces the child's allowlist.
        const agents = discoverAgentDefinitions(ctx.cwd);
        const def = agents.find(a => a.name === params.agent);
        const permittedList = agents.map(a => a.name).join(", ") || "(none)";
        if (!params.agent) {
          return fail(
            `You must specify which agent to spawn via the "agent" field. Available agents: ${permittedList}.`,
            "agent required",
          );
        }
        if (!def) {
          return fail(
            `You may not spawn the "${params.agent}" agent — it is not ` +
              `${SUBAGENT_ALLOWLIST ? "in your allowlist" : "a known agent"}. Available agents: ${permittedList}.`,
            SUBAGENT_ALLOWLIST ? "agent not in allowlist" : "unknown agent",
          );
        }

        // Validate prerequisites (need herdr + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isHerdrAvailable()) {
          return herdrUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return fail("Error: no session file. Start pi with a persistent session to use subagents.", "no session file");
        }

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parentArtifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          ctx.sessionManager.getSessionId(),
        );

        // Default the name to the agent name, then suffix it against running subagents and
        // every name in the registry, so names stay unique across the whole session.
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        const baseName = params.name?.trim() || params.agent;
        if (!isValidRunName(baseName)) return fail("Subagent name must be a single line of 1–64 characters without control characters.");
        const name = uniqueRunningName(baseName, registryNames);
        // No await before launchSubagent registers the name, so parallel spawns see it.
        const running = await launchSubagent({ ...params, name }, def, ctx, parentArtifactDir, { signal, toolCallId, thinking: pi.getThinkingLevel() });
        watchAndDeliver(running);

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            pane: running.surface,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        // Only show the agent tag separately when a distinct name was given.
        const agent =
          agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "●") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Validation or launch error
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List available agent profiles (project > global).",
      promptSnippet:
        "Use when unsure which agent fits; never to poll for completion.",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const list = discoverAgentDefinitions(ctx.cwd).filter((agent) => !agent.disableModelInvocation);

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : NO_AGENTS }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) return new Text(theme.fg("dim", NO_AGENTS), 0, 0);
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Message a subagent: steer it if running, resume its session if finished. " +
        "Steering waits for submission; resuming returns before completion, with the result steered back later.",
      promptSnippet:
        "After resuming, end your turn or do independent work. Do not wait, poll, or invent results.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Exact name returned by subagent; the same handle works after completion.",
        }),
        message: Type.String({
          description:
            "Message text.",
        }),
      }),

      renderCall(args, theme) {
        const target = args.name ?? "(unknown)";
        return new Text(
          "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;

        if (details?.status === "steered") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "●") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const requestedName = params.name?.trim();
        if (!requestedName) {
          return fail("Provide the subagent's `name` to steer (if running) or resume (if finished).");
        }
        const message = params.message?.trim();
        if (!message) return fail("`message` is required to steer or resume a subagent.");

        if (!isHerdrAvailable()) {
          return herdrUnavailableResult();
        }

        const name = requestedName;
        const runningMatch = [...runningSubagents.values()].find((r) => r.name === name);
        let sessionPath = runningMatch?.sessionFile;
        if (!sessionPath) {
          const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
          const registry = readNameRegistry(artifactDir);
          sessionPath = registryEntry(registry, name)?.sessionFile;
          if (!sessionPath) {
            const known = Object.keys(registry);
            return fail(`No subagent named "${name}" in this session. ` + (known.length
              ? `Known subagents: ${known.join(", ")}.`
              : "No subagents have been spawned in this session yet."));
          }
        }
        const sessionKey = resolve(sessionPath);
        if (startingSessions.has(sessionKey)) {
          return fail(`Subagent "${name}" is still starting; message it once it has started.`);
        }
        // Capture this lifecycle before queueing: a session switch must not send into the next session.
        const deliverySignal = signal ? AbortSignal.any([signal, getModuleAbortSignal()]) : getModuleAbortSignal();
        return messageInOrder(sessionKey, deliverySignal, async () => {
          // Look up again after the preceding delivery: it may have resumed the child.
          const runningSession = [...runningSubagents.values()].find((r) => resolve(r.sessionFile) === sessionKey);
          const steered = runningSession && await steerLive(runningSession, message, deliverySignal);
          if (steered) return steered;

          if (!existsSync(sessionPath)) {
            return fail(`Subagent "${name}" is registered but its session file is gone ` +
              `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`);
          }
          // Restore the saved identity and tool restrictions; refuse rather than lose them.
          const loadout = readSubagentLoadout(sessionPath);
          if (!loadout) {
            return fail(`Cannot safely resume "${name}": no loadout snapshot found for this session ` +
              `(it predates loadout snapshots, or its .loadout.json sidecar was removed). ` +
              `Resuming would drop its system prompt and tool restrictions, so this is refused. ` +
              `Re-run the task as a fresh subagent instead.`);
          }
          const resumedSessionId = getSessionId(sessionPath) ?? name;
          startingSessions.add(sessionKey);
          // A resumed run is autonomous; a live child taken back keeps how it was launched.
          const watchRun = (surface: string, herdrName: string, interactive = false): RunningSubagent => {
            const running: RunningSubagent = {
              id: randomUUID().slice(0, 8), name, task: message, agent: loadout.agent ?? undefined,
              surface, herdrName, startTime: Date.now(), sessionFile: sessionPath, interactive,
            };
            runningSubagents.set(running.id, running);
            watchAndDeliver(running);
            return running;
          };
          let running: RunningSubagent;
          try {
            // Adopt a live child lost during a parent restart instead of opening its transcript twice.
            const live = await launchDeps.findSessionAgent(sessionKey);
            deliverySignal.throwIfAborted();
            const steeredLive = live && await steerLive(watchRun(live.pane, live.agent, loadout.interactive), message, deliverySignal);
            if (steeredLive) return steeredLive;
            const args = ["--session", sessionPath, "-e", join(SUBAGENTS_DIR, "subagent-done.ts")];
            applyLoadoutToArgs(args, loadout, sessionPath);
            args.push(...await integrationArgs(loadout.agentDir ?? getAgentDir()));
            deliverySignal.throwIfAborted();
            // This run is autonomous: a parent that restarts and takes it back must see that.
            writeSubagentLoadout(sessionPath, { ...loadout, interactive: false });
            clearStaleMarkers(sessionPath);
            const started = await startTracked({
              name,
              args,
              env: subagentEnv(loadout, { name, sessionFile: sessionPath, autoExit: true }),
              cwd: loadout.cwd ?? ctx.cwd,
            }, message, deliverySignal);
            running = watchRun(started.surface, started.agent);
          } finally {
            startingSessions.delete(sessionKey);
          }
          return {
            content: [{ type: "text", text: `Session "${name}" resumed.` }],
            details: {
              id: running.id, name, sessionId: resumedSessionId, sessionFile: sessionPath,
              pane: running.surface, status: "started",
            },
          };
        });
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, ctx.cwd);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found among permitted project or global agents.`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: ${JSON.stringify(agentName)}, name: ${JSON.stringify(displayName)}, task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const titleSegment = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        // Success: icon already conveys "completed", so show "N tools · duration"
        // like the in-process extension. Failure: surface the failure reason.
        let header: string;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : details.endedEarly ? "ended early" : `failed (exit ${exitCode})`;
          header = `${titleSegment}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${titleSegment}${theme.fg("dim", toolPart)}`;
        }

        // Usage line: ↑in ↓out R… W… $cost · context-gauge (color-coded by %).
        let usageLine: string | null = null;
        if (stats) {
          const segs = formatUsageSegments(stats).map((s) => theme.fg("dim", s));
          if (stats.contextTokens > 0) {
            const window = stats.contextWindow;
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            const coloredCtx =
              pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
            segs.push(coloredCtx);
          }
          if (segs.length > 0) usageLine = segs.join(theme.fg("dim", " "));
        }

        // Older session messages predate the summary field.
        const summary = details.summary ?? (typeof message.content === "string" ? message.content : "")
          .replace(/\n\n(If more work is needed, f|F)ollow up with subagent_message[\s\S]+$/, "")
          .replace(/^Sub-agent "[^\n]*\n\n/, "");

        // Build content for the box
        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);
        // The provider's error, which a partial answer in the summary would otherwise hide.
        if (errorMessage && !summary.includes(errorMessage)) contentLines.push(theme.fg("error", `Error: ${errorMessage}`));

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) contentLines.push(summary);
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: ${JSON.stringify(details.name)}, message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", truncateToWidth(line, Math.max(0, width - 2))));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return box.render(width);
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, _options, theme) => {
    const details = message.details as any;
    const line = details?.line ?? details?.lines?.join("\n");
    if (!line) return undefined;

    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(
      `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}\n${theme.fg("dim", line)}`,
      0, 0,
    ));
    return box;
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    const name = details.name ?? "subagent";
    const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
    const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
    box.addChild(new Text(
      `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`,
      0, 0,
    ));
    if (options.expanded) {
      box.addChild(new Text(
        `\n${details.question ?? ""}\n\n${theme.fg("dim", `Reply: subagent_message({ name: ${JSON.stringify(name)}, message: "…" })`)}`,
        0, 0,
      ));
    } else {
      box.addChild(new TruncatedText(theme.fg("dim", (details.question ?? "").split("\n")[0])));
      box.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
    }
    return box;
  });

}
