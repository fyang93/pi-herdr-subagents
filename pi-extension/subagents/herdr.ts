/**
 * herdr operations. Each subagent is a named herdr agent in its own pane: an
 * unfocused split in the parent's tab (a background tab when no split fits),
 * started with `herdr agent start` so it shows in herdr's agents sidebar, with
 * state reported by herdr's pi integration. Pane ids look like `w1:p2`.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";

const execFileAsync = promisify(execFile);
// Bound CLI stalls, not agent execution time. Never retry mutating actions.
const cliOptions = { encoding: "utf8" as const, timeout: 10_000, killSignal: "SIGKILL" as const };
const bin = () => process.env.HERDR_BIN_PATH || "herdr";

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

export function herdrSetupHint(): string {
  return "Start pi inside a herdr pane (`herdr`, then `pi`).";
}

/** herdr prints `{result}` (plain text for `pane read`) or `{error: {code, message}}` with exit 1. */
function parse(stdout: string): any {
  if (!stdout.trim()) return undefined;
  const reply = JSON.parse(stdout);
  if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
  return reply.result;
}

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`herdr ${code}: ${message}`); this.code = code; }
}

function herdrError(error: any): never {
  for (const out of [error.stdout, error.stderr]) if (typeof out === "string" && out.startsWith("{")) parse(out);
  throw error;
}

function herdr(args: string[], raw = false): any {
  try { const stdout = execFileSync(bin(), args, cliOptions); return raw ? stdout : parse(stdout); }
  catch (error) { herdrError(error); }
}

async function herdrAsync(args: string[], options: { signal?: AbortSignal; timeout?: number; raw?: boolean } = {}): Promise<any> {
  try {
    const { stdout } = await execFileAsync(bin(), args, { ...cliOptions, signal: options.signal, timeout: options.timeout ?? cliOptions.timeout });
    return options.raw ? stdout : parse(stdout);
  } catch (error) { herdrError(error); }
}

/** Install or update herdr's pi integration so subagents report exact agent state. */
export async function ensurePiIntegration(): Promise<boolean> {
  const { stdout } = await execFileAsync(bin(), ["integration", "status"], cliOptions);
  if (/^pi: current\b/m.test(stdout)) return false;
  await execFileAsync(bin(), ["integration", "install", "pi"], cliOptions);
  return true;
}

// ── Starting agents ──

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/** Split direction that leaves both halves usable; a cell is about twice as tall as wide. */
export function splitDirection(width: number, height: number, minColumns: number, minRows: number): "right" | "down" | null {
  const fits = { right: Math.floor(width / 2) >= minColumns && height >= minRows, down: width >= minColumns && Math.floor(height / 2) >= minRows };
  const order: ("right" | "down")[] = height * 2 > width ? ["down", "right"] : ["right", "down"];
  return order.find(direction => fits[direction]) ?? null;
}

/** A herdr agent name ([a-z][a-z0-9_-]{0,31}) for a display name, unique among live agents. */
export function agentName(display: string, taken: Set<string>): string {
  const slug = display.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 28) || "subagent";
  let name = slug;
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  return name;
}

export interface AgentLaunch {
  /** Display name; the herdr agent name is derived from it. */
  name: string;
  kind: "pi" | "claude";
  args: string[];
  /** Submitted in order once the agent is ready; an agent started with a task would never look ready. */
  prompts: string[];
  env: Record<string, string>;
  cwd: string;
}

// Serialize layout inspection + creation within this parent so parallel launches see fresh geometry.
let creationQueue: Promise<unknown> = Promise.resolve();

/** Open a pane, start the agent once it is ready for input, then submit its prompts. */
export function startAgent(launch: AgentLaunch): Promise<{ surface: string; agent: string }> {
  const result = creationQueue.then(() => startAgentUnlocked(launch));
  creationQueue = result.catch(() => {});
  return result;
}

async function startAgentUnlocked(launch: AgentLaunch): Promise<{ surface: string; agent: string }> {
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) throw new Error(`herdr is not available. ${herdrSetupHint()}`);
  const minColumns = positiveInteger(process.env.PI_SUBAGENT_MIN_COLUMNS, 50);
  const minRows = positiveInteger(process.env.PI_SUBAGENT_MIN_ROWS, 15);
  const { layout } = await herdrAsync(["pane", "layout", "--pane", parent]);
  // Split the largest pane in the parent's tab; never unzoom or rearrange the user's layout.
  let best: { pane: string; direction: "right" | "down"; area: number } | undefined;
  for (const { pane_id, rect } of layout.zoomed ? [] : layout.panes) {
    const direction = splitDirection(rect.width, rect.height, minColumns, minRows);
    const area = rect.width * rect.height;
    if (direction && (!best || area > best.area)) best = { pane: pane_id, direction, area };
  }
  const env = Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const surface: string = best
    ? (await herdrAsync(["pane", "split", best.pane, "--direction", best.direction, "--no-focus", "--cwd", launch.cwd, ...env])).pane.pane_id
    : (await herdrAsync(["tab", "create", "--no-focus", "--label", launch.name, "--cwd", launch.cwd, ...env])).root_pane.pane_id;
  await herdrAsync(["pane", "rename", surface, launch.name]).catch(() => {});
  let agent = "";
  for (let attempt = 0; ; attempt++) {
    const taken = new Set<string>(((await herdrAsync(["agent", "list"]))?.agents ?? []).map((a: any) => a.name).filter(Boolean));
    agent = agentName(launch.name, taken);
    try {
      await herdrAsync(["agent", "start", agent, "--kind", launch.kind, "--pane", surface, "--timeout", "60000", "--", ...launch.args], { timeout: 70_000 });
      break;
    } catch (error) {
      // Another parent took the name meanwhile; nothing started, so pick again once.
      if (error instanceof HerdrError && error.code === "agent_name_taken" && attempt === 0) continue;
      // Blocked at startup (e.g. a trust prompt): leave the pane for the user to answer.
      if (error instanceof HerdrError && error.code === "agent_not_ready") {
        throw new Error(`Agent "${agent}" is blocked at a startup dialog in herdr pane ${surface}; answer it there and resend the task.`);
      }
      // Keep what the pane printed (a bad model, an extension error) before closing it.
      let output = "";
      try { output = readScreen(surface, 40).split("\n").filter((line) => line.trim()).slice(-8).join("\n"); } catch {}
      try { closeSurface(surface); } catch {}
      throw new Error(`${String((error as any)?.message ?? error)}${output ? `\nLast output in the pane:\n${output}` : ""}`);
    }
  }
  for (const prompt of launch.prompts) await herdrAsync(["agent", "prompt", agent, prompt]);
  return { surface, agent };
}

// ── Talking to running agents ──

/** Submit a (multi-line) message as one prompt; herdr rejects it while the agent awaits a confirmation. */
export function steer(surface: string, message: string): void {
  herdr(["agent", "prompt", surface, message]);
}

/** Recent output with soft wraps joined. */
export function readScreen(surface: string, lines = 50): string {
  return herdr(["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))], true).trimEnd();
}

export function closeSurface(surface: string): void {
  herdr(["pane", "close", surface]);
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The pane's agent status; "exited" when no agent runs in it (or the pane is gone); null when herdr could not answer. */
export async function agentStatus(surface: string, signal?: AbortSignal): Promise<AgentStatus | "exited" | null> {
  try {
    const { pane } = await herdrAsync(["pane", "get", surface], { signal });
    return pane.agent ? (pane.agent_status ?? "unknown") : "exited";
  } catch (error) {
    return error instanceof HerdrError && error.code === "pane_not_found" ? "exited" : null;
  }
}

// ── Completion ──

export interface ExitResult {
  reason: "done" | "quit" | "error" | "sentinel" | "interrupted";
  exitCode: number;
  /** Provider error, or why the agent ended without a completion marker. */
  errorMessage?: string;
}

/**
 * Decode the `.exit` marker subagent-done.ts writes when pi quits: `done`,
 * `error` when the last turn failed, or `quit` when someone ended it early. ask_question keeps the session open and
 * signals through a separate `.ask` file instead.
 */
export function interpretExitSidecar(data: any): ExitResult {
  if (data?.type === "error") {
    const errorMessage = typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
      ? data.errorMessage
      : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  if (data?.type === "quit") return { reason: "quit", exitCode: 1 };
  return { reason: "done", exitCode: 0 };
}

function readExitSidecar(sessionFile?: string): ExitResult | undefined {
  const exitFile = sessionFile && `${sessionFile}.exit`;
  try {
    if (!exitFile || !existsSync(exitFile)) return undefined;
    const data = JSON.parse(readFileSync(exitFile, "utf-8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch { return undefined; }
}

/**
 * Wait until the agent finishes: its `.exit` marker (pi), its sentinel file
 * (Claude's Stop hook), or the agent leaving its pane. Leaving without a
 * marker on two consecutive checks is an interruption; when `exitIsDone`,
 * leaving is the normal end (Claude has no exit marker).
 */
export async function waitForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; sessionFile?: string; sentinelFile?: string; exitIsDone?: boolean; onTick?: (status: AgentStatus | null) => void },
): Promise<ExitResult> {
  const aborted = () => new Error("Aborted while waiting for subagent to finish");
  let exitedBefore = false;
  for (;;) {
    if (signal.aborted) throw aborted();
    const marker = readExitSidecar(options.sessionFile);
    if (marker) return marker;
    if (options.sentinelFile && existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
    const status = await agentStatus(surface, signal).catch(() => null);
    if (signal.aborted) throw aborted();
    if (status === "exited") {
      // pi writes its marker just before exiting; look once more before calling it an interruption.
      const late = readExitSidecar(options.sessionFile);
      if (late) return late;
      if (options.exitIsDone) return { reason: "done", exitCode: 0 };
      if (exitedBefore) return { reason: "interrupted", exitCode: 1, errorMessage: `The agent in pane ${surface} exited without a completion marker.` };
      exitedBefore = true;
    } else {
      exitedBefore = false;
      options.onTick?.(status);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, options.interval);
      function onAbort() { clearTimeout(timer); reject(aborted()); }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
