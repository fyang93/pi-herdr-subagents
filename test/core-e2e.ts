// Opt-in: npm run test:core-e2e inside herdr-app / herdr-core.
// Uses the caller's core, but only creates/removes its own test terminals.
// No paid model calls, daemon restart or layout changes. Works on Windows/macOS/Linux.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent, waitForExit, closePane, findSessionAgent, agentStatus } from "../pi-extension/subagents/herdr.ts";
import { coreRequest, isCoreAvailable } from "../pi-extension/subagents/herdr-core.ts";
import { __test__ as watcher } from "../pi-extension/subagents/index.ts";
import { appCall, parentAppSpace, type AppSnapshot } from "../pi-extension/subagents/herdr-app.ts";
import { publishInboxMessage } from "../pi-extension/subagents/session.ts";

assert.ok(isCoreAvailable(), "Run inside a herdr-core terminal (HC_TERMINAL_ID and HC_TERMINAL_SOCKET required)");
const root = mkdtempSync(join(tmpdir(), "pi-core-e2e-"));
const config = join(root, "config"); mkdirSync(config);
mkdirSync(join(config, "extensions"));
const fixture = join(config, "extensions", "fixture.ts");
const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const owned = new Set<string>();
const withApp = process.argv.includes("--app");
if (!withApp) process.env.PI_SUBAGENT_APP_LAYOUT = "hidden";
else delete process.env.PI_SUBAGENT_APP_LAYOUT;
const beforeApp = withApp ? await appCall(["status"]) : null;
writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
writeFileSync(fixture, `import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))};
export default function(pi:any) {
 const faux=fauxProvider({provider:"core-e2e",models:[{id:"scripted",contextWindow:1000000}]});
 const respond=(ctx:any)=>{
   const orchestrate=ctx.messages.some((m:any)=>m.role==='user' && JSON.stringify(m.content).includes('ORCHESTRATE_CORE_E2E'));
   const called=ctx.messages.some((m:any)=>m.role==='toolResult');
   if(orchestrate&&!called)return fauxAssistantMessage(['e2e-scout','e2e-researcher','e2e-worker'].map(agent=>fauxToolCall('subagent',{agent,task:'Return CORE_E2E_OK'})));
   return fauxAssistantMessage('CORE_E2E_OK');
 };
 faux.setResponses(Array.from({length:100},()=>respond));
 pi.registerProvider(faux.provider);
}
`);
const done = join(repo, "pi-extension/subagents/subagent-done.ts");
const state = join(repo, "pi-extension/subagents/herdr-core-state.ts");
const session = (name: string) => join(root, `${name}.jsonl`);
async function launch(name: string, file = session(name), orchestrate = false) {
  for (const suffix of [".exit", ".exiting", ".paused"]) rmSync(file + suffix, { force: true });
  const child = await startAgent({ name, kind: "pi", cwd: root,
    args: ["--session", file, "--model", "core-e2e/scripted", "--thinking", "off", "--offline", "--no-mcp", "--approve", "-e", fixture, "-e", done, "-e", state, ...(orchestrate ? ["-e", join(repo, "pi-extension/subagents/index.ts")] : [])],
    env: { PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SUBAGENT_NAME: name, PI_SUBAGENT_SESSION: file, PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_ALLOWED: orchestrate ? "e2e-scout,e2e-researcher,e2e-worker" : "", PI_SUBAGENT_APP_LAYOUT: withApp ? "" : "hidden" },
  });
  owned.add(child.surface);
  return { ...child, file };
}
async function collect(child: Awaited<ReturnType<typeof launch>>, task = "Return CORE_E2E_OK. This is a local simulated model test.") {
  publishInboxMessage(child.file, task);
  const result = await waitForExit(child.agent, AbortSignal.timeout(60_000), { interval: 100, sessionFile: child.file });
  assert.equal(result.reason, "done", JSON.stringify(result));
  assert.match(result.summary ?? "", /CORE_E2E_OK/);
  const entries = readFileSync(child.file, "utf8"); assert.match(entries, /CORE_E2E_OK/);
  await closePane(child.surface); owned.delete(child.surface);
  return result;
}
try {
  const children = await Promise.all([launch("core-scout"), launch("core-researcher"), launch("core-worker")]);
  assert.equal(new Set(children.map(c => c.surface)).size, 3);
  for (const child of children) {
    assert.deepEqual(await findSessionAgent(resolve(child.file)), { agent: child.agent, pane: child.surface });
    assert.notEqual(await agentStatus(child.agent), "exited");
  }
  console.log("Created 3 real Pi terminals:", children.map(c => c.surface).join(", "));
  if (withApp) {
    const layout: AppSnapshot = await appCall(["ls"]);
    const spaceID = parentAppSpace(layout, process.env.HC_TERMINAL_ID!);
    const space = layout.spaces.find(s => s.id === spaceID)!;
    assert.ok(space, "Parent must be visible in the app for this test");
    const tabs = children.map(child => space.tabs.find(t => t.terminals.some(p => p.terminal === child.surface))?.id);
    assert.ok(tabs.every(Boolean), "Every child has a pane in the parent's space");
    assert.equal(new Set(tabs).size, 3, "Each child has a separate tab");
    const afterApp = await appCall(["status"]);
    assert.equal(afterApp.tab, beforeApp.tab, "Current tab stays selected");
    assert.equal(afterApp.focused_pane, beforeApp.focused_pane, "Keyboard focus stays put");
    console.log("PASS: 3 separate app tabs; current tab and pane focus unchanged");
  }
  await Promise.all(children.map(child => collect(child)));
  console.log("PASS: 3 parallel real Pi processes, inbox delivery, local model, auto-exit, summary collection and cleanup");
  const resumed = await launch("core-worker-resumed", children[2].file);
  await collect(resumed);
  console.log("PASS: resume the same saved Pi session in a new terminal");
  mkdirSync(join(config, "agents"));
  for (const name of ["e2e-scout", "e2e-researcher", "e2e-worker"]) {
    writeFileSync(join(config, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Local simulated e2e role\ntools: read\nauto-exit: true\nsystem-prompt: append\n---\nReturn CORE_E2E_OK.\n`);
  }
  const orchestrator = await launch("core-orchestrator", session("orchestrator"), true);
  await collect(orchestrator, "ORCHESTRATE_CORE_E2E: dispatch the three agents and collect their results");
  const transcript = readFileSync(orchestrator.file, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const results = transcript.filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result");
  assert.equal(results.length, 3, "The orchestrator received all three real tool-dispatched results");
  assert.ok(results.every(entry => JSON.stringify(entry).includes("CORE_E2E_OK")));
  console.log("PASS: real subagent tool -> 3 real Pi children -> result delivery -> orchestrator auto-exit");
  const failedSession = session("crashed");
  const failed = await coreRequest("terminal.run", {
    argv: [process.execPath, "-e", "console.error('CORE_CRASH_DIAGNOSTIC'); process.exit(23)"],
    cwd: root, keep: false, wait: false, no_notify: true,
    parent: process.env.HC_TERMINAL_ID,
    labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(failedSession) },
  });
  owned.add(failed.address);
  // This synthetic crash uses node, not the managed pi/claude launch contract.
  // Observe its actual finished record before testing abnormal-exit diagnostics;
  // do not mistake the live node fixture's argv for a recovered shell.
  for (const deadline = Date.now() + 10_000; ; ) {
    const record = await coreRequest("terminal.get", { terminal: failed.address });
    if (record.state === "finished") break;
    assert.ok(Date.now() < deadline, "Synthetic crash did not actually finish");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const interrupted = await watcher.watchSubagent({ id: failed.address, name: "crashed", herdrName: failed.address, surface: failed.address, sessionFile: failedSession, startTime: Date.now() } as any, AbortSignal.timeout(60_000));
  assert.equal(interrupted.exitCode, 1);
  assert.match(interrupted.summary, /exit_code=23/);
  assert.match(interrupted.summary, /CORE_CRASH_DIAGNOSTIC/);
  await assert.rejects(coreRequest("terminal.get", { terminal: failed.address }), (error: any) => error.code === "not_found");
  owned.delete(failed.address);
  console.log("PASS: real abnormal exit captures exit code/output and removes only the finished record");
} finally {
  const cleanup = await Promise.allSettled([...owned].map(id => closePane(id)));
  if (cleanup.some(r => r.status === "rejected")) console.error("Cleanup failed; inspect owned terminals:", [...owned]);
  else rmSync(root, { recursive: true, force: true });
}
