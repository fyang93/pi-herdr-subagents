/**
 * herdr operations. Each subagent is a named herdr agent in its own pane: an
 * unfocused split of the parent's pane (a background tab when that is too small),
 * started with `herdr agent start` so it shows in herdr's agents sidebar, with
 * state reported by herdr's pi integration. Pane ids look like `w1:p2`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";

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

async function herdrAsync(args: string[], options: { signal?: AbortSignal; timeout?: number; raw?: boolean } = {}): Promise<any> {
  try {
    const { stdout } = await execFileAsync(bin(), args, { ...cliOptions, signal: options.signal, timeout: options.timeout ?? cliOptions.timeout });
    return options.raw ? stdout : parse(stdout);
  } catch (error) { herdrError(error); }
}

let integrationPath: string | null = null;

/**
 * Where herdr installed its pi integration, as found by `ensurePiIntegration`, or null.
 * herdr installs it in the default config directory, so a child using another one must
 * load it explicitly to report its state and session.
 */
export function piIntegrationPath(): string | null {
  return integrationPath && existsSync(integrationPath) ? integrationPath : null;
}

/** Install or update herdr's pi integration so subagents report exact agent state; true if it installed. */
export async function ensurePiIntegration(): Promise<boolean> {
  const status = async () => {
    const { stdout } = await execFileAsync(bin(), ["integration", "status"], cliOptions);
    integrationPath = /^pi: \S+.*\((\/[^)]+)\)$/m.exec(stdout)?.[1] ?? null;
    return /^pi: current\b/m.test(stdout);
  };
  if (await status()) return false;
  await execFileAsync(bin(), ["integration", "install", "pi"], cliOptions);
  await status();
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
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

// Serialize layout inspection + pane creation within this parent so parallel launches see fresh geometry.
let creationQueue: Promise<unknown> = Promise.resolve();

/** Open an unfocused pane for an agent: a split of the parent's own pane, or a background tab. */
async function openPane(launch: AgentLaunch, signal?: AbortSignal): Promise<string> {
  // Ask herdr for the caller's pane: HERDR_PANE_ID is only a launch-time alias after a move.
  const { pane: current } = await herdrAsync(["pane", "current", "--current"], { signal });
  const parent = current.pane_id;
  const minColumns = positiveInteger(process.env.PI_SUBAGENT_MIN_COLUMNS, 80);
  const minRows = positiveInteger(process.env.PI_SUBAGENT_MIN_ROWS, 24);
  const { layout } = await herdrAsync(["pane", "layout", "--pane", parent], { signal });
  // Split only the parent's own pane, never another pane the user may be working in;
  // a background tab when it is too small or zoomed. Never unzoom or rearrange the layout.
  const own = layout.zoomed ? undefined : layout.panes.find((pane: any) => pane.pane_id === parent);
  const direction = own && splitDirection(own.rect.width, own.rect.height, minColumns, minRows);
  const env = Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  // Neither abortable nor timed out: herdr may create the pane before it answers, and only
  // the answer names it for cleanup.
  return direction
    ? (await herdrAsync(["pane", "split", parent, "--direction", direction, "--no-focus", "--cwd", launch.cwd, ...env], { timeout: 0 })).pane.pane_id
    : (await herdrAsync(["tab", "create", "--workspace", current.workspace_id, "--no-focus", "--label", launch.name, "--cwd", launch.cwd, ...env], { timeout: 0 })).root_pane.pane_id;
}

/**
 * Open a pane and start the agent, waiting for Pi to be ready.
 * Every failure after the pane exists closes it, and so does `signal`: the caller
 * never learns the pane, so nothing else would.
 */
export async function startAgent(launch: AgentLaunch, signal?: AbortSignal): Promise<{ surface: string; agent: string }> {
  if (!isHerdrAvailable()) throw new Error(`herdr is not available. ${herdrSetupHint()}`);
  // herdr refuses agent arguments it cannot encode for the pane's shell, such as line breaks.
  const unsafe = launch.args.find((arg) => /[\r\n]/.test(arg));
  if (unsafe !== undefined) throw new Error(`A pi argument for "${launch.name}" spans lines, which herdr cannot pass: ${JSON.stringify(unsafe.slice(0, 80))}`);
  const opening = creationQueue.then(() => openPane(launch, signal));
  creationQueue = opening.catch(() => {});
  const surface = await opening;
  await herdrAsync(["pane", "rename", surface, launch.name]).catch(() => {});
  try {
    signal?.throwIfAborted();
    let agent = "";
    for (let attempt = 0; ; attempt++) {
      const taken = new Set<string>(((await herdrAsync(["agent", "list"], { signal }))?.agents ?? []).map((a: any) => a.name).filter(Boolean));
      agent = agentName(launch.name, taken);
      try {
        await herdrAsync(["agent", "start", agent, "--kind", "pi", "--pane", surface, "--timeout", "60000", "--", ...launch.args], { signal, timeout: 70_000 });
        break;
      } catch (error) {
        // Another parent took the name meanwhile; nothing started, so pick again once.
        if (error instanceof HerdrError && error.code === "agent_name_taken" && attempt === 0) continue;
        if (error instanceof HerdrError && error.code === "agent_not_ready") {
          throw new Error(`pi did not become ready; it may be waiting at a startup dialog (such as trusting ${launch.cwd}). Answer it by running pi there once, then spawn again.`);
        }
        throw error;
      }
    }
    return { surface, agent };
  } catch (error) {
    // Keep what the pane printed (a bad model, an extension error) before closing it.
    let output = "";
    try { output = (await readScreen(surface, 40)).split("\n").filter((line) => line.trim()).slice(-8).join("\n"); } catch {}
    const leftOpen = await closePane(surface).then(() => "", () => `\nIts herdr pane ${surface} could not be closed; close it in herdr.`);
    throw new Error(`${String((error as any)?.message ?? error)}${output ? `\nLast output in the pane:\n${output}` : ""}${leftOpen}`);
  }
}

/** Recent output with soft wraps joined. */
export async function readScreen(surface: string, lines = 50): Promise<string> {
  return (await herdrAsync(["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))], { raw: true })).trimEnd();
}

export async function closeSurface(surface: string): Promise<void> {
  await herdrAsync(["pane", "close", surface]);
}

/** Close a pane, retrying briefly; one already gone counts as closed. Throws when it stays open. */
export async function closePane(surface: string, close: (surface: string) => void | Promise<void> = closeSurface): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await close(surface);
    } catch (error: any) {
      if (error?.code === "pane_not_found") return;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * A live agent's state and current pane, by herdr agent name: the name follows the
 * agent when its pane moves, a pane id does not. "exited" once herdr no longer
 * lists it; null when herdr could not answer.
 */
export async function agentStatus(agent: string, signal?: AbortSignal): Promise<{ status: AgentStatus; pane: string; session: string | null } | "exited" | null> {
  try {
    const result = (await herdrAsync(["agent", "get", agent], { signal })).agent;
    return { status: result.agent_status ?? "unknown", pane: result.pane_id, session: result.agent_session?.kind === "path" && typeof result.agent_session.value === "string" ? result.agent_session.value : null };
  } catch (error) {
    return error instanceof HerdrError && error.code === "agent_not_found" ? "exited" : null;
  }
}

/** The live pi agent running a session file, by herdr's session report; null when none is. */
export async function findSessionAgent(sessionFile: string): Promise<{ agent: string; pane: string } | null> {
  const agents: any[] = (await herdrAsync(["agent", "list"]))?.agents ?? [];
  const live = agents.find((a) => a.name && a.agent_session?.kind === "path" && typeof a.agent_session.value === "string" && resolve(a.agent_session.value) === resolve(sessionFile));
  return live ? { agent: live.name, pane: live.pane_id } : null;
}

/**
 * Follow herdr's events for one pane over its own socket until the returned
 * function is called. `notify(true)` means something about the pane may have
 * changed; `notify(false)` means events are unavailable, so the caller polls.
 */
function watchPaneEvents(pane: string, notify: (live: boolean) => void): () => void {
  let socket: Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    if (stopped || !process.env.HERDR_SOCKET_PATH) return;
    const current = createConnection(process.env.HERDR_SOCKET_PATH);
    socket = current;
    current.setEncoding("utf8");
    current.unref();
    let buffer = "";
    let ready = false;
    const handshake = setTimeout(() => current.destroy(), 10_000);
    handshake.unref();
    current.once("connect", () => current.write(`${JSON.stringify({
      id: "subagents", method: "events.subscribe", params: { subscriptions: [
        { type: "pane.agent_status_changed", pane_id: pane },
        { type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.moved" },
      ] },
    })}\n`));
    current.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) return current.destroy();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { return current.destroy(); }
        if (message?.error) return current.destroy(); // includes events_lost
        if (!ready) {
          if (message?.result?.type !== "subscription_started") return current.destroy();
          clearTimeout(handshake);
          ready = true;
          notify(true);
        } else if (message?.event === "pane_moved" || message?.data?.pane_id === pane) notify(true);
      }
    });
    current.on("error", () => {});
    current.once("close", () => {
      clearTimeout(handshake);
      if (stopped) return;
      notify(false);
      retry = setTimeout(connect, 1000);
      retry.unref();
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.destroy();
  };
}

// ── Completion ──

export interface ExitResult {
  reason: "done" | "quit" | "error" | "interrupted";
  exitCode: number;
  /** Provider error, or why the agent ended without a completion marker. */
  errorMessage?: string;
  /** The run's final answer, as the child read it from its active branch. */
  summary?: string;
}

/**
 * Decode the `.exit` marker subagent-done.ts writes when pi quits: `done`,
 * `error` when the last turn failed, or `quit` when someone ended it early. ask_question keeps the session open and
 * signals through `.ask/` instead.
 */
export function interpretExitSidecar(data: any): ExitResult {
  const summary = typeof data?.summary === "string" && data.summary ? { summary: data.summary } : {};
  if (data?.type === "error") {
    const errorMessage = typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
      ? data.errorMessage
      : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage, ...summary };
  }
  if (data?.type === "quit") return { reason: "quit", exitCode: 1, ...summary };
  return { reason: "done", exitCode: 0, ...summary };
}

function readExitSidecar(sessionFile?: string): ExitResult | undefined {
  const exitFile = sessionFile && `${sessionFile}.exit`;
  try {
    if (!exitFile || !existsSync(exitFile)) return undefined;
    return interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf-8")));
  } catch { return undefined; }
}

/**
 * Wait until the agent finishes. Its `.exit` marker is the result, but pi writes it
 * during its shutdown, while other extensions may still be cleaning up: the agent is
 * done once herdr no longer lists it, or `exitGrace` ms after the marker appeared.
 * Leaving without a marker on two consecutive checks is an interruption.
 */
export async function waitForExit(
  agent: string,
  signal: AbortSignal,
  options: { interval: number; sessionFile?: string; exitGrace?: number; onTick?: (status: AgentStatus | null, pane?: string) => void },
): Promise<ExitResult> {
  const aborted = () => new Error("Aborted while waiting for subagent to finish");
  let exitedBefore = false;
  let markerSince: number | undefined;
  let found: Awaited<ReturnType<typeof agentStatus>> = null;
  // herdr is asked for the status on start, on each event, every 15 s as a safety
  // net, and every `interval` while events are unavailable.
  let check = true, live = false, lastCheck = 0;
  let wake: (() => void) | undefined;
  let pane: string | undefined;
  let stopEvents = () => {};
  const notify = (isLive: boolean) => { live = isLive; check = true; wake?.(); };
  try {
    for (;;) {
      if (signal.aborted) throw aborted();
      const marker = readExitSidecar(options.sessionFile);
      if (marker && Date.now() - (markerSince ??= Date.now()) >= (options.exitGrace ?? 30_000)) return marker;
      if (check || !live || exitedBefore || marker || Date.now() - lastCheck >= 15_000) {
        check = false;
        found = await agentStatus(agent, signal);
        if (found && found !== "exited" && options.sessionFile && found.session && resolve(found.session) !== resolve(options.sessionFile)) found = "exited";
        lastCheck = Date.now();
        if (found && found !== "exited" && found.pane !== pane) {
          pane = found.pane;
          stopEvents();
          stopEvents = watchPaneEvents(pane, notify);
        }
      }
      if (signal.aborted) throw aborted();
      if (found === "exited") {
        // pi writes its marker just before exiting; look once more before calling it an interruption.
        const late = marker ?? readExitSidecar(options.sessionFile);
        if (late) return late;
        if (exitedBefore) return { reason: "interrupted", exitCode: 1, errorMessage: `Agent ${agent} exited without a completion marker.` };
        exitedBefore = true;
      } else {
        exitedBefore = false;
        options.onTick?.(found?.status ?? null, found?.pane);
      }
      if (check && !exitedBefore) continue;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); wake = undefined; resolve(); };
        const timer = setTimeout(finish, options.interval);
        function onAbort() { clearTimeout(timer); signal.removeEventListener("abort", onAbort); wake = undefined; reject(aborted()); }
        wake = exitedBefore ? undefined : finish;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
  } finally {
    stopEvents();
  }
}
