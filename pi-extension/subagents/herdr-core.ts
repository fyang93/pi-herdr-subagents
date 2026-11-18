/** herdr-core's local JSON-RPC backend (Unix socket or Windows named pipe).
 * Uses the API rather than shell commands so argv, env and Windows paths survive intact.
 * Terminals are immutable IDs, not reusable display names. No app layout is changed.
 */
import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { AgentLaunch, AgentStatus } from "./herdr.ts";
import { presentCoreTerminal } from "./herdr-app.ts";

export function isCoreAvailable(): boolean {
  return !!process.env.HC_TERMINAL_ID && !!process.env.HC_TERMINAL_SOCKET;
}

export class CoreError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`herdr-core ${code}: ${message}`); this.code = code; }
}

/** A new plain JSON-lines connection per request; never retry a mutation. */
export function coreRequest(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeout?: number } = {}): Promise<any> {
  return new Promise((done, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason ?? new Error("Aborted")); return; }
    const path = process.env.HC_TERMINAL_SOCKET;
    if (!path) { reject(new Error("HC_TERMINAL_SOCKET is missing")); return; }
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    let buffer = "", settled = false;
    const timer = options.timeout === 0 ? undefined : setTimeout(() => finish(new Error(`herdr-core ${method} timed out`)), options.timeout ?? 10_000);
    const abort = () => finish(options.signal?.reason ?? new Error("Aborted"));
    function finish(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else done(result);
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.on("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error(`herdr-core closed during ${method}`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return finish(new Error("herdr-core response is too large"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const reply = JSON.parse(line);
          if (reply.id !== 1) continue;
          if (reply.error) finish(new CoreError(reply.error.data?.kind ?? String(reply.error.code), reply.error.message));
          else finish(undefined, reply.result);
        } catch (error) { finish(error as Error); }
      }
    });
  });
}

const SESSION = "pi.subagent.session";
const MANAGED = "pi.subagent.managed";

function sessionFor(launch: AgentLaunch): string | undefined {
  if (launch.kind === "pi") return launch.env.PI_SUBAGENT_SESSION;
  const index = launch.args.findIndex((arg) => arg === "--session-id" || arg === "--resume");
  return index < 0 ? undefined : launch.args[index + 1];
}

export async function startCoreAgent(launch: AgentLaunch, signal?: AbortSignal): Promise<{ surface: string; agent: string }> {
  signal?.throwIfAborted();
  // Validate the inherited identity before creating anything (stale/nested environments).
  await coreRequest("terminal.get", { terminal: process.env.HC_TERMINAL_ID }, { signal });
  const session = sessionFor(launch);
  if (!session) throw new Error("Cannot launch a herdr-core subagent without a session identity");
  // No cancellable/timeout window during creation: losing the response could orphan a child.
  // No name constraint/race: retain display names as labels and supervise by terminal ID.
  const terminal = await coreRequest("terminal.run", {
    argv: [launch.kind === "pi" ? "pi" : "claude", ...launch.args],
    cwd: launch.cwd,
    env: launch.env,
    caller: process.env.HC_TERMINAL_ID,
    parent: process.env.HC_TERMINAL_ID,
    no_notify: true, // This extension delivers results; avoid duplicate hc notes.
    keep: false,
    wait: false,
    labels: { [MANAGED]: "1", [SESSION]: launch.kind === "pi" ? resolve(session) : session, "pi.subagent.name": launch.name, "pi.subagent.parent": process.env.HC_TERMINAL_ID! },
  }, { timeout: 0 });
  if (typeof terminal?.address !== "string") throw new Error("herdr-core returned no terminal address");
  try {
    signal?.throwIfAborted();
    if (terminal.reason === "spawn_pending" || terminal.state === "finished") {
      throw new Error(`herdr-core could not start ${launch.kind}: ${terminal.reason ?? terminal.exit_code}`);
    }
    try {
      await presentCoreTerminal(terminal.address, process.env.HC_TERMINAL_ID!, launch.name, coreRequest);
    } catch (error) {
      // Presentation is optional; never orphan a functioning child on an app/UI error.
      console.warn(`Could not show subagent ${terminal.address} in herdr-app: ${error}`);
    }
    signal?.throwIfAborted();
    return { surface: terminal.address, agent: terminal.address };
  } catch (error) {
    await closeCoreTerminal(terminal.address);
    throw error;
  }
}

export async function closeCoreTerminal(terminal: string): Promise<void> {
  try {
    await coreRequest("terminal.kill", { terminal });
    await coreRequest("terminal.rm", { terminal });
  } catch (error) {
    if (!(error instanceof CoreError && error.code === "not_found")) throw error;
  }
}

export async function coreAgentStatus(agent: string, signal?: AbortSignal): Promise<{ status: AgentStatus; pane: string; session: string | null } | "exited" | null> {
  try {
    const terminal = await coreRequest("terminal.get", { terminal: agent }, { signal });
    if (terminal.state === "finished") return "exited";
    // A late app adoption may enable shell recovery after presentation timed out.
    // Keep managed agents final on exit/crash, including without the app CLI.
    if (terminal.keep && terminal.labels?.[MANAGED] === "1") {
      await coreRequest("terminal.keep", { terminal: agent, keep: false }, { signal });
    }
    const state = terminal.status?.state;
    const status: AgentStatus = state === "idle" || state === "working" || state === "blocked" || state === "done" ? state : state === "error" ? "blocked" : "unknown";
    return { status, pane: terminal.address, session: terminal.labels?.[SESSION] ?? null };
  } catch (error) {
    return error instanceof CoreError && error.code === "not_found" ? "exited" : null;
  }
}

export async function findCoreSessionAgent(session: string): Promise<{ agent: string; pane: string } | null> {
  const { terminals } = await coreRequest("terminal.list", { labels: { [MANAGED]: "1" } });
  const terminal = terminals.find((t: any) => t.state === "live" && t.labels?.[SESSION] === session);
  return terminal ? { agent: terminal.address, pane: terminal.address } : null;
}

export async function readCoreScreen(terminal: string, lines: number): Promise<string> {
  return (await coreRequest("terminal.read", { terminal, lines: Math.max(0, lines) })).text.trimEnd();
}

export async function promptCoreAgent(terminal: string, text: string, signal?: AbortSignal): Promise<void> {
  // Human draft protection may legitimately hold a send for longer than 10 seconds.
  await coreRequest("terminal.send", { terminal, text, caller: process.env.HC_TERMINAL_ID }, { signal, timeout: 0 });
}
