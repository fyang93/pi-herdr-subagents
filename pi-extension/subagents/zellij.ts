/**
 * Zellij pane operations and exit polling. Pane ids are `terminal_<id>`.
 * Use size-bounded tiled splits in the parent's tab; overflow into background tabs.
 * Never request stacked panes or switch the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { positiveInteger, selectPlacement, type PaneGeometry, type Placement } from "./zellij-layout.ts";

const execFileAsync = promisify(execFile);
// Bound CLI stalls, not agent execution time. Never retry mutating actions.
const cliOptions = { encoding: "utf8" as const, timeout: 10_000, killSignal: "SIGKILL" as const };
function requireSurface(surface: string): void {
  if (!/^terminal_\d+$/.test(surface)) throw new Error(`Invalid terminal pane id: ${surface}`);
}

// ── Availability ──

let zellijOnPath: boolean | undefined;

export function isZellijAvailable(): boolean {
  // Zellij sets this to "0" inside panes (it is a presence marker).
  if (!process.env.ZELLIJ) return false;
  if (zellijOnPath === undefined) {
    try {
      execFileSync("sh", ["-c", "command -v zellij"], { stdio: "ignore" });
      zellijOnPath = true;
    } catch {
      zellijOnPath = false;
    }
  }
  return zellijOnPath;
}

export function zellijSetupHint(): string {
  return "Start pi inside Zellij 0.44+ (`zellij`, then `pi`).";
}

// Zellij 0.44 added pane-targeted CLI actions and returned pane ids.
let zellijVersionChecked = false;
let supportsBackgroundTabs = false;
function requireZellij(): void {
  if (!isZellijAvailable()) throw new Error(`Zellij is not available. ${zellijSetupHint()}`);
  if (zellijVersionChecked) return;
  checkZellijVersion(execFileSync("zellij", ["--version"], cliOptions));
}

function checkZellijVersion(version: string): void {
  const match = version.match(/zellij (\d+)\.(\d+)\.(\d+)/);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 44)) {
    throw new Error("Subagents require Zellij 0.44+ for pane-targeted CLI actions.");
  }
  supportsBackgroundTabs = Number(match[1]) > 0 || Number(match[2]) >= 45;
  zellijVersionChecked = true;
}

function zellijAction(args: string[]): string {
  requireZellij();
  return execFileSync("zellij", ["action", ...args], cliOptions);
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Wrap a shell-quoted executable and arguments; exec preserves the recorded PID. */
export function withProcessId(command: string, pidFile: string): string {
  const wrapper = `printf '%s\\n' "$$" > "$1" || exit; shift; exec "$@"`;
  return `bash -c ${shellEscape(wrapper)} -- ${shellEscape(pidFile)} ${command}`;
}

// ── Surface primitives ──

// Serialize layout inspection + creation within this parent, without blocking input.
// A rejected creation must not poison subsequent launches. No mutating CLI retries.
let creationQueue: Promise<unknown> = Promise.resolve();
export function createSurface(name: string, fromSurface?: string): Promise<string> {
  const parent = fromSurface ?? process.env.ZELLIJ_PANE_ID;
  const result = creationQueue.then(() => createSurfaceUnlocked(name, parent));
  creationQueue = result.catch(() => {});
  return result;
}

async function createSurfaceUnlocked(name: string, fromSurface?: string): Promise<string> {
  if (!process.env.ZELLIJ) throw new Error(`Zellij is not available. ${zellijSetupHint()}`);
  const parent = fromSurface?.replace(/^terminal_/, "") ?? process.env.ZELLIJ_PANE_ID;
  if (!parent || !/^\d+$/.test(parent)) {
    throw new Error("A valid ZELLIJ_PANE_ID is required to create a subagent pane.");
  }
  if (!zellijVersionChecked) {
    const { stdout } = await execFileAsync("zellij", ["--version"], cliOptions);
    checkZellijVersion(stdout);
  }
  let placement: Placement = null;
  const minColumns = positiveInteger(process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS, 50);
  const minRows = positiveInteger(process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS, 15);
  // Unknown geometry must not turn into an uncontrolled split of the parent.
  try {
    const { stdout } = await execFileAsync("zellij", ["action", "list-panes", "--json", "--geometry", "--state", "--tab"], {
      ...cliOptions, env: { ...process.env, ZELLIJ_PANE_ID: parent },
    });
    placement = selectPlacement(parsePaneList(stdout), Number(parent), minColumns, minRows);
  } catch {} // Unknown geometry must not turn into an uncontrolled split.
  const marker = `pi-create-${randomUUID()}`;
  if (placement === null) return createSurfaceInNewTab(name, marker);
  let pane = "";
  let failure: unknown;
  try {
    const { stdout } = await execFileAsync("zellij", ["action", "new-pane", supportsBackgroundTabs ? "--no-focus" : "--near-current-pane",
      "--direction", placement.direction, "--name", marker], {
      ...cliOptions,
      env: { ...process.env, ZELLIJ_PANE_ID: String(placement.paneId) },
    });
    pane = stdout.trim();
  } catch (error) { failure = error; }
  if (!/^terminal_\d+$/.test(pane)) {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      try {
        const { stdout } = await execFileAsync("zellij", ["action", "list-panes", "--json", "--all"], {
          ...cliOptions, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        });
        const matches = JSON.parse(stdout)
          .filter((p: any) => !p.is_plugin && p.title === marker && Number.isSafeInteger(p.id) && p.id >= 0);
        if (matches.length === 1) { pane = `terminal_${matches[0].id}`; break; }
      } catch (error) { failure = error; }
      const remaining = deadline - performance.now();
      if (remaining > 0) await sleep(Math.min(50, remaining));
    }
  }
  if (!/^terminal_\d+$/.test(pane)) {
    throw new Error(`Could not confirm Zellij pane creation (${marker}); not retried to avoid duplicate tasks. ${failure ?? pane}`);
  }
  try { await execFileAsync("zellij", ["action", "rename-pane", "--pane-id", pane, "--", name], cliOptions); }
  catch (error) { console.warn(`Pane ${pane} created as ${marker}, but rename failed: ${error}`); }
  return pane;
}

/** Create exactly one terminal in a background tab; never replay an ambiguous mutation. */
async function createSurfaceInNewTab(name: string, marker: string): Promise<string> {
  if (!supportsBackgroundTabs) {
    throw new Error("No safe tiled split remains. Upgrade to Zellij 0.45+ for background tabs (--no-focus); no tab was created.");
  }
  let tabId: number | undefined;
  let failure: unknown;
  try {
    const { stdout } = await execFileAsync("zellij", ["action", "new-tab", "--no-focus", "--name", marker,
      "--cwd", process.cwd()], cliOptions);
    const rawId = stdout.trim();
    if (/^\d+$/.test(rawId) && Number.isSafeInteger(Number(rawId))) tabId = Number(rawId);
  } catch (error) { failure = error; }

  // A lost CLI reply is ambiguous: find the unique marker tab, but never create
  // another one. Polling only observes state; it does not replay the mutation.
  const deadline = performance.now() + 2000;
  let pane = "";
  let createdTabId = tabId;
  while (performance.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("zellij", ["action", "list-panes", "--json", "--all"], {
        ...cliOptions, timeout: Math.max(1, Math.ceil(deadline - performance.now())),
      });
      const matches = parsePaneList(stdout).filter(p => !p.is_plugin && p.tab_name === marker &&
        Number.isSafeInteger(p.tab_id) && p.tab_id! >= 0 &&
        (tabId === undefined || p.tab_id === tabId));
      if (matches.length === 1) {
        pane = `terminal_${matches[0].id}`;
        createdTabId = matches[0].tab_id;
        break;
      }
    } catch (error) { failure = error; }
    const remaining = deadline - performance.now();
    if (remaining > 0) await sleep(Math.min(50, remaining));
  }
  if (!/^terminal_\d+$/.test(pane)) {
    throw new Error(`Could not confirm Zellij tab/pane creation (${marker}); not retried to avoid duplicates. ${failure ?? tabId ?? "no pane found"}`);
  }
  if (Number.isSafeInteger(createdTabId)) {
    try { await execFileAsync("zellij", ["action", "rename-tab", "--tab-id", String(createdTabId), "--", name], cliOptions); }
    catch (error) { console.warn(`Tab ${createdTabId} created as ${marker}, but rename failed: ${error}`); }
  }
  try { await execFileAsync("zellij", ["action", "rename-pane", "--pane-id", pane, "--", name], cliOptions); }
  catch (error) { console.warn(`Pane ${pane} created in tab ${createdTabId ?? marker}, but rename failed: ${error}`); }
  return pane;
}

/** Send literal text to a pane, then submit with Enter. */
export function sendCommand(surface: string, command: string): void {
  requireSurface(surface);
  zellijAction(["write-chars", "--pane-id", surface, "--", command]);
  zellijAction(["write", "--pane-id", surface, "13"]);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync), joining soft-wrapped lines.
 */
export function readScreen(surface: string, lines = 50): string {
  requireSurface(surface);
  const dir = mkdtempSync(join(tmpdir(), "pi-screen-"));
  try {
    const path = join(dir, "screen");
    zellijAction(["dump-screen", "--pane-id", surface, "--full", "--path", path]);
    return readScreenTail(path, lines);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Read only the requested tail, not the whole scrollback into a child-process buffer.
function readScreenTail(path: string, lines: number): string {
  if (!Number.isSafeInteger(lines)) throw new Error("Screen line count must be an integer");
  lines = Math.max(1, lines);
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    const chunks: string[] = [];
    while (position > 0) {
      const block = Buffer.alloc(Math.min(position, 64 * 1024));
      position -= block.length;
      const bytes = readSync(fd, block, 0, block.length, position);
      if (bytes !== block.length) throw new Error("Incomplete Zellij screen dump");
      // Leave a split UTF-8 codepoint for the next block; decode every byte once.
      let start = 0;
      if (position > 0) while (start < 3 && (block[start] & 0xc0) === 0x80) start++;
      position += start;
      let text = block.subarray(start).toString("utf8");
      if (chunks.length === 0) text = text.trimEnd();
      if (!text) continue;
      let newline = text.length;
      while ((newline = text.lastIndexOf("\n", newline - 1)) >= 0) {
        if (--lines === 0) {
          chunks.push(text.slice(newline + 1));
          return chunks.reverse().join("");
        }
        if (newline === 0) break;
      }
      chunks.push(text);
    }
    return chunks.reverse().join("");
  } finally { closeSync(fd); }
}

/**
 * Read the screen contents of a pane (async), joining soft-wrapped lines.
 * Pollers should use viewport-only mode; full scrollback is more expensive.
 */
export async function readScreenAsync(
  surface: string,
  lines = 50,
  options?: { full?: boolean; signal?: AbortSignal },
): Promise<string> {
  requireSurface(surface);
  requireZellij();
  const args = ["action", "dump-screen", "--pane-id", surface];
  if (options?.full === false) {
    const { stdout } = await execFileAsync("zellij", args, { ...cliOptions, signal: options.signal });
    return stdout.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n");
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-screen-"));
  try {
    const path = join(dir, "screen");
    await execFileAsync("zellij", [...args, "--full", "--path", path], { ...cliOptions, signal: options?.signal });
    return readScreenTail(path, lines);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireSurface(surface);
  zellijAction(["close-pane", "--pane-id", surface]);
  // Zellij auto_layout re-applies its KDL swap layout on close.
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "interrupted";
  /** Shell exit code from sentinel, 1 for errors/interruption, or 0 for done. */
  exitCode: number;
  /** Diagnostic for provider errors or an exit without a completion marker. */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

function parsePaneList(stdout: string): PaneGeometry[] {
  const panes = JSON.parse(stdout);
  if (!Array.isArray(panes) || !panes.every(p => p && Number.isSafeInteger(p.id) &&
      p.id >= 0 && typeof p.is_plugin === "boolean")) throw new Error("Invalid Zellij pane list");
  return panes;
}

// Fallback only: share both successful and failed queries for 5s, so startup or
// server trouble cannot cause one list-panes process per agent per second.
interface PaneSample { generation: number; panes: Set<string> | null }
let paneSample: { key: string; until: number; value: PaneSample } | undefined;
let paneQuery: { key: string; controller: AbortController; users: number; promise: Promise<PaneSample> } | undefined;
let paneGeneration = 0;
async function queryPaneSample(signal: AbortSignal): Promise<PaneSample> {
  if (signal.aborted) throw new Error("Aborted");
  const key = `${process.env.ZELLIJ_SESSION_NAME ?? ""}\0${process.env.ZELLIJ_SOCKET_DIR ?? ""}`;
  if (paneSample?.key === key && performance.now() < paneSample.until) return paneSample.value;
  if (!paneQuery || paneQuery.key !== key || paneQuery.controller.signal.aborted) {
    const controller = new AbortController();
    const query = { key, controller, users: 0, promise: Promise.resolve(null as unknown as PaneSample) };
    query.promise = (async () => {
      let panes: Set<string> | null = null;
      try {
        const { stdout } = await execFileAsync("zellij", ["action", "list-panes", "--json", "--all"], {
          ...cliOptions, signal: controller.signal,
        });
        panes = new Set(parsePaneList(stdout).filter(p => !p.is_plugin).map(p => `terminal_${p.id}`));
      } catch {} // Failure is unknown, never evidence that a pane disappeared.
      const value = { generation: ++paneGeneration, panes };
      if (!controller.signal.aborted) paneSample = { key, until: performance.now() + 5000, value };
      return value;
    })().finally(() => { if (paneQuery === query) paneQuery = undefined; });
    paneQuery = query;
  }
  const query = paneQuery;
  query.users++;
  try {
    return await new Promise<PaneSample>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(new Error("Aborted")); };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      query.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) onAbort();
    });
  } finally {
    // One cancelled watcher must not abort the query for other watchers.
    if (--query.users === 0 && paneQuery === query) query.controller.abort();
  }
}

export const __pollForExitTest__ = {
  interpretExitSidecar, queryPaneSample,
  clearPaneSample() { paneSample = undefined; },
};

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    pidFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  let previousInterruption: string | undefined;
  let previousPaneGeneration: number | undefined;
  let screenFailures = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5, { full: false, signal });
      screenFailures = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      screenFailures++;
      if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
      // Keep the original retry policy: a transient CLI failure is not a task exit.
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    let interruption: string | undefined;
    let pidAlive = false;
    let freshObservation = true;
    if (options.pidFile) {
      try {
        const pid = Number(readFileSync(options.pidFile, "utf8").trim());
        if (Number.isSafeInteger(pid) && pid > 0) {
          // Probe only; never kill. PID reuse can delay detection.
          try { process.kill(pid, 0); pidAlive = true; }
          catch (error: any) {
            if (error.code === "ESRCH") interruption = `Subagent process ${pid} exited without a completion marker.`;
            // EPERM and other probe errors do not establish that the process exited.
          }
        }
      } catch {} // No PID yet, or unreadable metadata: keep watching.
    }
    if (interruption) {
      // Collapsed stacks can have a one-line viewport: the shell prompt may
      // push the sentinel into scrollback. Only inspect history after OS exit.
      try {
        const screen = await readScreenAsync(surface, 50, { signal });
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      } catch {} // Keep OS exit confirmation even if the pane no longer exists.
    } else if (!pidAlive || screenFailures >= 2) {
      try {
        const sample = await queryPaneSample(signal);
        freshObservation = sample.generation !== previousPaneGeneration;
        previousPaneGeneration = sample.generation;
        if (sample.panes && !sample.panes.has(surface)) {
          interruption = `Pane ${surface} was closed before completion was observed.`;
        }
      } catch {} // A failed CLI query is not evidence of a closed pane.
    }
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
    // Require another OS probe or a NEW pane snapshot (not the cached absence),
    // checking completion markers again first:
    // the shell can still be about to print its sentinel when Pi has just exited.
    if (freshObservation && interruption && interruption === previousInterruption) {
      return { reason: "interrupted", exitCode: 1, errorMessage: interruption };
    }
    previousInterruption = interruption;

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
