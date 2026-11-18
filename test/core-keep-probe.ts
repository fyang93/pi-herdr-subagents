// Called only by core-keep-e2e.py with a newly created isolated daemon/socket.
import assert from "node:assert/strict";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { agentStatus, findSessionAgent, closeSurface, waitForExit } from "../pi-extension/subagents/herdr.ts";
import { coreRequest } from "../pi-extension/subagents/herdr-core.ts";
import { __test__ as watcher } from "../pi-extension/subagents/index.ts";

const id = process.env.PROBE_TERMINAL!;
const session = process.env.PROBE_SESSION!;
const phase = process.argv[2];
if (phase === "done" || phase === "cancel") {
  assert.notEqual(await agentStatus(id), "exited");
  if (phase === "done") writeFileSync(session + ".exit", JSON.stringify({ type: "done", summary: "LIVE_RESULT" }));
  const result = await watcher.watchSubagent({ id, name: "original fake Pi", herdrName: id, surface: id, sessionFile: session, startTime: Date.now() } as any,
    phase === "cancel" ? AbortSignal.abort() : new AbortController().signal, {
      wait: (agent, signal, options) => waitForExit(agent, signal, { ...options, exitGrace: 0 }),
    });
  assert.equal(result.exitCode, phase === "done" ? 0 : 1);
  await assert.rejects(coreRequest("terminal.get", { terminal: id }), (error: any) => error.code === "not_found");
  console.log(`PASS original ${phase}: owned original Pi cleaned up`);
  process.exit(0);
}
if (phase === "original") {
  const original = await coreRequest("terminal.get", { terminal: id });
  assert.deepEqual(original.argv, ["pi"]);
  assert.notEqual(await agentStatus(id), "exited", `the original fake Pi must not be mistaken for recovery: ${JSON.stringify(original)}`);
  assert.deepEqual(await findSessionAgent(session), { agent: id, pane: id });
  assert.deepEqual((await coreRequest("terminal.get", { terminal: id })).argv, ["pi"]);
} else {
  assert.equal(phase, "recovered");
  assert.equal(await agentStatus(id), "exited");
  assert.equal(await findSessionAgent(session), null, "resume must not adopt the shell with stale labels");
  const running = () => ({ id, name: "fake Pi", herdrName: id, surface: id, sessionFile: session, startTime: Date.now() }) as any;
  const wait: typeof waitForExit = (agent, signal, options) => waitForExit(agent, signal, { ...options, interval: 5 });
  if (!existsSync(session + ".exit")) writeFileSync(session + ".exit", JSON.stringify({ type: "done", summary: "ORIGINAL_RESULT" }));
  const marked = await watcher.watchSubagent(running(), new AbortController().signal, { wait });
  assert.equal(marked.exitCode, 0);
  assert.equal(marked.summary, "ORIGINAL_RESULT");
  rmSync(session + ".exit", { force: true });
  const interrupted = await watcher.watchSubagent(running(), new AbortController().signal, { wait });
  assert.equal(interrupted.exitCode, 1);
  assert.match(interrupted.summary, /interrupted/);
  const cancelled = await watcher.watchSubagent(running(), AbortSignal.abort(), { wait });
  assert.match(cancelled.summary, /cancelled/);
  await closeSurface(id, session); // shared start-failure/shutdown cleanup boundary
}
const terminal = await coreRequest("terminal.get", { terminal: id });
assert.equal(terminal.state, "live");
assert.equal(terminal.keep, true, "queries and cleanup must respect keep");
console.log(`PASS ${phase}: status, lookup${phase === "recovered" ? ", marker, markerless interruption, cancel and close preserve replacement" : " recognize original pi argv"}`);
