import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

/**
 * The active branch up to the turn that spawns the fork: the assistant message holding
 * the spawning tool call is left out, since its batch is unresolved. A run need not
 * start with a user message (a subagent's result can start one), so that is no boundary.
 * A call made from a codemode script has a nested id (`call-1/1`); the transcript holds
 * its enclosing call (`call-1`).
 */
function forkContext(branch: SessionEntry[], forkPoint?: string): SessionEntry[] {
  const encloses = (id: unknown) => typeof id === "string" && (forkPoint === id || !!forkPoint?.startsWith(`${id}/`));
  const spawning = branch.findIndex((entry) =>
    entry.type === "message" && (entry as MessageEntry).message?.content?.some?.((part) => part.type === "toolCall" && encloses(part.id)));
  return spawning === -1 ? branch : branch.slice(0, spawning);
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  /** The parent's active branch (root to leaf), copied in fork mode. */
  parentBranch: SessionEntry[];
  /** The tool call spawning the fork; the branch is copied up to the message holding it. */
  forkPoint?: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const entries = params.mode === "fork" ? forkContext(params.parentBranch, params.forkPoint) : [];
  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

/**
 * A snapshot of the subagent loadout used by `subagent_message({ name })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Native resume restores history, model and thinking, but rebuilds the
 * system prompt and tools from the current CLI flags and patches the session
 * to match — a bare `--session` resume drops the identity and tool restriction.
 * Resume therefore replays this snapshot's `--tools` restriction, identity,
 * spawn whitelist, cwd, and config dir (not the model, which the session
 * owns). Extensions are discovered from the current configuration.
 * Storing the resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); older snapshots may have null. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether a human drives it, so a blocked dialog does not wake the parent; absent in older snapshots. */
  interactive?: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file; a failure fails the launch. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
}

const isNullableString = (value: unknown) => value === null || typeof value === "string";

/** Read a subagent's loadout snapshot, or null if absent, unparseable, or malformed. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const parsed = JSON.parse(readFileSync(loadoutSidecarPath(sessionFile), "utf8"));
    // A malformed snapshot must refuse resume, not launch with default prompt/tools.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const valid =
      ["agent", "toolAllowlist", "identity", "cwd", "agentDir"].every((key) => isNullableString(parsed[key])) &&
      (parsed.systemPromptMode === null || parsed.systemPromptMode === "append" || parsed.systemPromptMode === "replace") &&
      (parsed.spawnable === null || (Array.isArray(parsed.spawnable) && parsed.spawnable.every((name: unknown) => typeof name === "string"))) &&
      (parsed.interactive === undefined || typeof parsed.interactive === "boolean");
    return valid ? (parsed as SubagentLoadout) : null;
  } catch {
    return null;
  }
}

// ── Questions ────────────────────────────────────────────────────────────────
// A subagent's questions are immutable files in `<session>.ask/`, each published by
// rename: the child never rewrites what the parent may be reading, and the parent
// removes only the questions it delivered.

/** Publish a question for the parent; throws when it cannot be written. */
export function publishQuestion(sessionFile: string, question: string): void {
  const dir = `${sessionFile}.ask`;
  mkdirSync(dir, { recursive: true });
  const tmp = `${dir}-${randomUUID()}.tmp`; // outside the directory: never read half-written
  writeFileSync(tmp, JSON.stringify({ question }));
  // Named by the monotonic clock, so they sort in the order asked, even within a millisecond.
  renameSync(tmp, join(dir, `${String(process.hrtime.bigint()).padStart(20, "0")}-${randomUUID()}.json`));
}

/** Questions waiting for delivery, in the order asked, and the files holding them (malformed ones included). */
export function pendingQuestions(sessionFile: string): { files: string[]; questions: string[] } {
  const dir = `${sessionFile}.ask`;
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch {} // none asked
  const files = names.map((name) => join(dir, name));
  const questions = files.flatMap((file) => {
    try {
      const { question } = JSON.parse(readFileSync(file, "utf8"));
      return typeof question === "string" && question.trim() ? [question] : [];
    } catch {
      return [];
    }
  });
  return { files, questions };
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file; its header holds the session id. */
  sessionFile: string;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const parsed = JSON.parse(readFileSync(nameRegistryPath(artifactDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as NameRegistry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry. A failure throws: the name would otherwise not be addressable.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  mkdirSync(artifactDir, { recursive: true });
  // A computed key defines an own property for any name, `__proto__` included.
  const registry = { ...readNameRegistry(artifactDir), [name]: entry };
  const p = nameRegistryPath(artifactDir);
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, p);
}

/** A name's entry in a registry, or null: only its own entries are names, `__proto__` included. */
export function registryEntry(registry: NameRegistry, name: string): NameRegistryEntry | null {
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined;
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

/**
 * Read only the first line of a file: session files grow to many MB, but the
 * header is always the first JSON line. Returns it (sans newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
export function getSessionId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  const last = findLastAssistantText(entries);
  if (last === null || last.startsWith("Subagent error: ")) return last;
  // An extension message (e.g. a background fetch finishing) can start another run
  // after the agent already gave its answer; that run's short reply must not
  // replace it. Keep every completed reply since the last user input.
  const replies: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = (entry as MessageEntry).message as { role: string; content: any[]; stopReason?: unknown };
    if (message.role === "user") break;
    if (message.role !== "assistant" || message.stopReason !== "stop") continue;
    const text = textOf(message.content);
    if (text) replies.unshift(text);
  }
  return replies.length > 1 && replies[replies.length - 1] === last ? replies.join("\n\n") : last;
}

function textOf(content: any[]): string {
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    .map((block) => block.text as string)
    .join("\n");
  return text.trim() ? text : "";
}

function findLastAssistantText(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const text = textOf(msg.message.content);
    if (text) return text;

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

export interface SessionStats {
  model: string | null;
  provider: string | null;
  /** The model's context window from pi's model registry, when known. */
  contextWindow?: number;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Aggregate a completed subagent session's entries into stats for display: model,
 * tool-call count, billed token usage + cost, and current context size. Billing counts
 * what Pi's own session stats count: assistant turns, tool results that ran a model,
 * standalone usage entries, compactions and branch summaries. The context size is the
 * last assistant turn's `totalTokens` (the live context window occupancy).
 */
export function summarizeSessionStats(entries: SessionEntry[]): SessionStats {
  const stats: SessionStats = {
    model: null,
    provider: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const bill = (usage: any) => {
    if (!usage || typeof usage !== "object") return;
    stats.inputTokens += num(usage.input);
    stats.outputTokens += num(usage.output);
    stats.cacheReadTokens += num(usage.cacheRead);
    stats.cacheWriteTokens += num(usage.cacheWrite);
    stats.cost += num(usage.cost?.total);
  };

  for (const entry of entries as any[]) {
    if (entry.type === "model_change") {
      if (typeof entry.modelId === "string" && entry.modelId) stats.model = entry.modelId;
      if (typeof entry.provider === "string" && entry.provider) stats.provider = entry.provider;
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      bill(entry.usage);
      // After a compaction the context size is unknown until the next assistant turn, as Pi treats it.
      if (entry.type === "compaction") stats.contextTokens = 0;
    } else if (entry.type === "message" && entry.message?.role === "toolResult") {
      bill(entry.message.usage);
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      const msg = entry.message;
      if (typeof msg.model === "string" && msg.model) stats.model = msg.model;
      if (typeof msg.provider === "string" && msg.provider) stats.provider = msg.provider;
      if (Array.isArray(msg.content)) stats.toolCount += msg.content.filter((block: any) => block?.type === "toolCall").length;
      bill(msg.usage);
      if (num(msg.usage?.totalTokens) > 0) stats.contextTokens = num(msg.usage.totalTokens);
    }
  }

  return stats;
}

/**
 * The tool a running session is executing: the last message is an assistant
 * tool call with no result after it. Reads only the file's tail.
 */
export function currentTool(sessionFile: string, tailBytes = 64 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, tailBytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try { entry = JSON.parse(lines[i]); } catch { continue; } // blank, or cut by the tail
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
      const calls = message.content.filter((part: any) => part?.type === "toolCall" && typeof part.name === "string");
      return calls.at(-1)?.name;
    }
  } catch {} // missing or unreadable: no tool to show
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}
