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

/** Only our terminal.run records start with literal pi/claude (core retains argv).
 * A kept terminal can remain live while finish records a loss reason, then clears
 * that reason when its replacement shell starts. Labels survive both phases.
 * Missing argv / unrelated records are not evidence of process loss.
 */
function managedProgramLost(record: any): boolean {
  if (record?.state !== "live" || record.labels?.[MANAGED] !== "1") return false;
  if (typeof record.reason === "string" && record.reason.length > 0) return true;
  const command = record.argv?.[0];
  return typeof command === "string" && command !== "pi" && command !== "claude";
}

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
  // argv[0] is also a template name in core, not an unconditionally literal executable.
  // Do not let a user's template replace the CLI or turn its flags into a first prompt.
  let templates: any;
  try {
    ({ templates } = await coreRequest("templates.list", {}, { signal }));
  } catch (cause) {
    throw new Error("Cannot safely verify herdr-core templates before launch; this core may not support templates.list. Update herdr-core and retry.", { cause });
  }
  if (!Array.isArray(templates)) throw new Error("herdr-core returned an invalid templates list; refusing to launch");
  if (templates.some((template: any) => typeof template?.name === "string" && template.name.toLowerCase() === launch.kind)) {
    throw new Error(`herdr-core template conflict: template "${launch.kind}" overrides the ${launch.kind} executable. Rename or remove that template before spawning a subagent.`);
  }
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
    if (terminal.state === "finished") {
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
    await closeCoreTerminal(terminal.address, launch.kind === "pi" ? resolve(session) : session);
    throw error;
  }
}

export async function closeCoreTerminal(terminal: string, session?: string): Promise<void> {
  try {
    // A completion marker (or cancellation) is not ownership of a replacement
    // shell or a /new session. Recheck at this single backend cleanup boundary.
    // The get/kill pair is not atomic; core offers no conditional kill operation.
    const record = await coreRequest("terminal.get", { terminal });
    if (record.labels?.[MANAGED] !== "1" || (session && record.labels?.[SESSION] !== session)
      || managedProgramLost(record) || (record.state !== "live" && record.state !== "finished")
      || (record.state === "live" && !["pi", "claude"].includes(record.argv?.[0]))) {
      console.warn(`Preserving herdr-core terminal ${terminal}: no longer the owned subagent program/session.`);
      return;
    }
    if (record.state === "live") await coreRequest("terminal.kill", { terminal });
    await coreRequest("terminal.rm", { terminal });
  } catch (error) {
    if (!(error instanceof CoreError && error.code === "not_found")) throw error;
  }
}

/** Diagnose a vanished child, removing only its confirmed finished, still-owned record.
 * Never kill here: "exited" can also mean a missing record, and labels may have changed.
 * All RPC failures become diagnostics, not a lost watcher result.
 */
export async function collectCoreInterruptedExit(terminal: string, session: string): Promise<string> {
  const ownedFinished = (record: any) => session && record?.state === "finished"
    && record.labels?.[MANAGED] === "1" && record.labels?.[SESSION] === session;
  try {
    const record = await coreRequest("terminal.get", { terminal });
    if (!ownedFinished(record)) return "";
    let diagnostics = `herdr-core terminal ${terminal} finished (exit_code=${record.exit_code ?? "unknown"}, reason=${record.reason ?? "unknown"}).`;
    try {
      const output = await readCoreScreen(terminal, 40);
      if (output) diagnostics += `\nLast terminal output:\n${output}`;
    } catch (error) {
      diagnostics += `\nCould not read terminal output: ${error}`;
    }
    try {
      // Reading output was asynchronous; ownership must still hold at removal time.
      if (ownedFinished(await coreRequest("terminal.get", { terminal }))) {
        await coreRequest("terminal.rm", { terminal });
      }
    } catch (error) {
      diagnostics += `\nCould not remove finished terminal ${terminal}: ${error}`;
    }
    return diagnostics;
  } catch (error) {
    return `Could not inspect herdr-core terminal ${terminal}: ${error}`;
  }
}

export async function coreAgentStatus(agent: string, signal?: AbortSignal): Promise<{ status: AgentStatus; pane: string; session: string | null } | "exited" | null> {
  try {
    const terminal = await coreRequest("terminal.get", { terminal: agent }, { signal });
    if (terminal.state === "finished") return "exited";
    if (managedProgramLost(terminal)) return "exited";
    const state = terminal.status?.state;
    const status: AgentStatus = state === "idle" || state === "working" || state === "blocked" || state === "done" || state === "error" ? state : "unknown";
    return { status, pane: terminal.address, session: terminal.labels?.[SESSION] ?? null };
  } catch (error) {
    return error instanceof CoreError && error.code === "not_found" ? "exited" : null;
  }
}

export async function findCoreSessionAgent(session: string): Promise<{ agent: string; pane: string } | null> {
  const { terminals } = await coreRequest("terminal.list", { labels: { [MANAGED]: "1" } });
  const terminal = terminals.find((t: any) => t.state === "live" && t.labels?.[SESSION] === session && !managedProgramLost(t));
  return terminal ? { agent: terminal.address, pane: terminal.address } : null;
}

export async function readCoreScreen(terminal: string, lines: number): Promise<string> {
  return (await coreRequest("terminal.read", { terminal, lines: Math.max(0, lines) })).text.trimEnd();
}

export async function promptCoreAgent(terminal: string, text: string, signal?: AbortSignal): Promise<void> {
  // Human draft protection may legitimately hold a send for longer than 10 seconds.
  await coreRequest("terminal.send", { terminal, text, caller: process.env.HC_TERMINAL_ID }, { signal, timeout: 0 });
}
