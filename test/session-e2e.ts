// Standalone, opt-in: node test/session-e2e.ts
// Real local Pi 1.1 + production herdr helpers, with a registered in-memory model.
// Every native CLI invocation is pinned to an owned named server, never the caller's server.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { closeSurface, startAgent, waitForExit } from "../pi-extension/subagents/herdr.ts";

import { pendingInboxMessages, publishInboxMessage } from "../pi-extension/subagents/session.ts";

assert.notEqual(process.platform, "win32", "This private PTY fixture needs a POSIX shell.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realHerdr = execFileSync("/bin/sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
const bash = execFileSync("/bin/sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const piCLI = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const installedIntegration = join(homedir(), ".pi/agent/extensions/herdr-agent-state.ts");
assert.ok(existsSync(installedIntegration), "Install the official herdr Pi integration first.");
assert.ok(existsSync(piCLI), "Install this repository's local Pi 1.1 dependencies first.");
const originalEnv = { ...process.env };
const base = mkdtempSync(join(tmpdir(), "pi-session-e2e-"));
const server = `pi-session-e2e-${process.pid}-${Date.now().toString(36)}`;
const project = join(base, "project"), agentDir = join(base, "agent"), binDir = join(base, "bin");
const auditFile = join(base, "herdr-calls.jsonl");
const integration = join(agentDir, "extensions/herdr-agent-state.ts");
const fixture = join(agentDir, "extensions/session-fixture.ts");
const done = join(repo, "pi-extension/subagents/subagent-done.ts");
const exec = promisify(execFile);
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const controllers: AbortController[] = [];
const watches: Promise<unknown>[] = [];
let daemon: ReturnType<typeof spawn> | undefined;
let ownsServer = false;

async function cli(args: string[], raw = false): Promise<any> {
  const { stdout } = await exec(realHerdr, ["--session", server, ...args], {
    env: process.env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (raw || !stdout.trim()) return stdout;
  const reply = JSON.parse(stdout);
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}
async function wait<T>(get: () => T | Promise<T>, label: string, timeout = 30_000): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < until) {
    try { const value = await get(); if (value) return value as NonNullable<T>; }
    catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}${last ? `; last error: ${last}` : ""}`);
}
const live = async () => (await cli(["agent", "list"])).agents as any[];
const entries = (file: string): any[] => {
  try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
};
const received = (file: string, text: string) => entries(file).some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(text));
const answered = (file: string, text: string) => entries(file).some(e => e.type === "message" && e.message.role === "assistant" && JSON.stringify(e.message.content).includes(text));
const audit = () => entries(auditFile);
async function gone(pane: string) {
  await wait(async () => {
    try { await cli(["pane", "get", pane]); return false; }
    catch (error: any) {
      // A failed socket/CLI request is not proof the pane vanished.
      for (const output of [error.stdout, error.stderr]) {
        try { if (JSON.parse(output).error?.code === "pane_not_found") return true; } catch {}
      }
      throw error;
    }
  }, `${pane} removed`);
}
const plan = (tag: string, gate?: string, error?: string) => `SESSION_E2E:${JSON.stringify({ tag, steps: gate ? [{ tool: "session_e2e_gate", args: { gate } }] : [], error })}`;
function watch(agent: string, file: string) {
  const controller = new AbortController(); controllers.push(controller);
  const ticks: { status: string | null; pane?: string }[] = [];
  const result = waitForExit(agent, controller.signal, {
    interval: 100, sessionFile: file,
    onTick(status, pane) { ticks.push({ status, pane }); },
  });
  // Attach a rejection handler immediately, including when assertions fail before awaiting it.
  watches.push(result.catch(() => {}));
  return { result, ticks };
}
// The extensible options also allow future error/start-failure cases without changing production interfaces.
async function launch(name: string, options: { autoExit?: boolean; prompt?: string; args?: string[]; sessionFile?: string } = {}) {
  const file = options.sessionFile ?? join(project, `${name}.jsonl`);
  const started = await startAgent({
    name, cwd: project,
    env: { HERDR_BIN_PATH: join(binDir, "herdr-private"), PI_SUBAGENT_SESSION: file, PI_SUBAGENT_NAME: name, PI_SUBAGENT_AGENT: "session-e2e", PI_SUBAGENT_AUTO_EXIT: options.autoExit === false ? "0" : "1" },
    args: ["--session", file, "--offline", "--no-mcp", "--no-themes", "--no-approve",
      "-e", integration, "-e", fixture, "-e", done, "--model", "session-e2e/scripted", "--thinking", "off", "--tools", "session_e2e_gate", ...(options.args ?? [])],
  });
  if (options.prompt) publishInboxMessage(file, options.prompt);
  return { ...started, file };
}
async function moved(pane: string, label: string) {
  const result = await cli(["pane", "move", pane, "--new-workspace", "--no-focus", "--label", label]);
  const current = result.move_result?.pane?.pane_id;
  assert.equal(typeof current, "string", JSON.stringify(result));
  assert.notEqual(current, pane, "Cross-workspace move must change the public pane ID.");
  return current as string;
}

try {
  for (const dir of [project, binDir, join(agentDir, "extensions"), join(base, "home"), join(base, "xdg")]) mkdirSync(dir, { recursive: true });
  copyFileSync(installedIntegration, integration); // Never install/update the user's managed extension.
  const privateEnv = { ...originalEnv };
  for (const key of Object.keys(privateEnv)) {
    if (key.startsWith("HERDR_") || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SESSION_") || key.startsWith("PI_CODING_AGENT_") || key === "PI_DENY_TOOLS" || key === "BASH_ENV" || key === "ENV") delete privateEnv[key];
  }
  Object.assign(privateEnv, {
    HOME: join(base, "home"), XDG_CONFIG_HOME: join(base, "xdg"),
    HERDR_CONFIG_PATH: join(base, "herdr.toml"), HERDR_BIN_PATH: join(binDir, "herdr-private"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SESSION_E2E: server,
    PI_SUBAGENT_MIN_COLUMNS: "10000", PI_SUBAGENT_MIN_ROWS: "10000", // Stable background-tab topology.
    PATH: `${binDir}:${originalEnv.PATH ?? ""}`, TERM: "xterm-256color",
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, privateEnv);
  writeFileSync(join(binDir, "pi"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(piCLI)} "$@"\n`, { mode: 0o700 });
  // A slow shell startup that, like fish's terminal queries or a prompt plugin, reads away
  // input typed before its prompt: pi must start only once the prompt is up.
  writeFileSync(join(binDir, "shellrc"), `sleep 1\nread -r -s -t 0.2 -d "" _\nPS1='$ '\n`);
  writeFileSync(join(binDir, "shell"), `#!/bin/sh\nexec ${quote(bash)} --noprofile --rcfile ${quote(join(binDir, "shellrc"))} -i\n`, { mode: 0o700 });
  writeFileSync(join(base, "herdr.toml"), `onboarding = false\n[terminal]\ndefault_shell = ${JSON.stringify(join(binDir, "shell"))}\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }));
  // This wrapper is also inherited by detached child closers. The literal named-server
  // prefix and removal of socket selectors prevent any fallback to the harness server.
  writeFileSync(join(binDir, "herdr-private"), `#!${process.execPath}
const {execFileSync} = require("node:child_process");
const {appendFileSync} = require("node:fs");
const args = process.argv.slice(2), env = {...process.env};
delete env.HERDR_SOCKET_PATH; delete env.HERDR_SESSION; delete env.HERDR_SESSION_NAME;
let stdout = "", stderr = "", code = 0;
try { stdout = execFileSync(${JSON.stringify(realHerdr)}, ["--session", ${JSON.stringify(server)}, ...args], {env, encoding:"utf8", timeout:15000, stdio:["ignore","pipe","pipe"]}); }
catch (e) { stdout = e.stdout || ""; stderr = e.stderr || ""; code = typeof e.status === "number" ? e.status : 1; }
appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({args, session:process.env.PI_SUBAGENT_SESSION, inheritedPane:process.env.HERDR_PANE_ID, stdout, stderr, code})+"\\n");
process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code);
`, { mode: 0o700 });
  // The fixture registers only an in-memory provider: no localhost HTTP service or external model traffic.
  writeFileSync(fixture, `import {fauxProvider,fauxAssistantMessage,fauxToolCall} from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))};
import {Type} from ${JSON.stringify(fileURLToPath(import.meta.resolve("typebox")))};
import {existsSync,appendFileSync} from "node:fs";
import {resolve,sep} from "node:path";
import {setTimeout as sleep} from "node:timers/promises";
import {execFileSync} from "node:child_process";
export default function(pi:any) {
 if (process.env.PI_SESSION_E2E !== ${JSON.stringify(server)}) throw new Error("Not an owned session-e2e server");
 // Simulate Pi refusing submission so delivery tests can inspect an unread file.
 const send=pi.sendUserMessage;
 pi.sendUserMessage=(...args:any[])=>{if(existsSync(process.env.PI_SUBAGENT_SESSION+".test-refuse-input"))throw new Error("Test submission failure");return send(...args);};
 pi.on("input",(event:any,ctx:any)=>appendFileSync(${JSON.stringify(join(base, "inputs.jsonl"))},JSON.stringify({session:process.env.PI_SUBAGENT_SESSION,text:event.text,idle:ctx.isIdle()})+"\\n"));
 const faux=fauxProvider({provider:"session-e2e",models:[{id:"scripted",contextWindow:1000000}]});
 const respond=(ctx:any)=>{
  // Replay system messages in order, as a provider does, for the effective prompt and tools.
  const sections:any={},tools=new Set<string>();let text="";
  for(const m of ctx.messages){if(m.role!=="system")continue;
   text+=typeof m.content==="string"?m.content:m.content.map((c:any)=>c.text??"").join("");
   for(const [k,v] of Object.entries(m.sections??{})){if(v===null)delete sections[k];else sections[k]=v;}
   for(const t of m.toolsAdded??[])tools.add(t.name);for(const t of m.toolsRemoved??[])tools.delete(t.name);}
  for(const t of ctx.tools??[])tools.add(t.name);
  const prompt=(ctx.systemPrompt??"")+text+Object.values(sections).join("\\n");
  appendFileSync(${JSON.stringify(join(base, "requests.jsonl"))},JSON.stringify({session:process.env.PI_SUBAGENT_SESSION,tools:[...tools].sort(),identity:prompt.includes("E2E_IDENTITY_MARKER")})+"\\n");
  let index=-1,plan:any;
  for(let i=ctx.messages.length-1;i>=0;i--){
   const m=ctx.messages[i];if(m.role!=="user")continue;
   const text=typeof m.content==="string"?m.content:m.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\\n");
   const match=text.match(/SESSION_E2E:(\\{[^\\n]+\\})/);
   if(match){index=i;plan=JSON.parse(match[1]);break;}
  }
  if(!plan) return fauxAssistantMessage("NOTED");
  if(plan.error)return fauxAssistantMessage("",{stopReason:"error",errorMessage:plan.error});
  const n=ctx.messages.slice(index+1).filter((m:any)=>m.role==="toolResult").length;
  const step=plan.steps[n];return step?fauxAssistantMessage(fauxToolCall(step.tool,step.args)):fauxAssistantMessage("RESULT:"+plan.tag);
 };
 faux.setResponses(Array.from({length:200},()=>respond)); pi.registerProvider(faux.provider);
 pi.registerTool({name:"session_e2e_gate",label:"Private gate",description:"Wait for an owned test barrier.",parameters:Type.Object({gate:Type.String()}),
  async execute(_id:any,args:any,signal:any,_update:any,ctx:any){
   const file=resolve(ctx.cwd,args.gate);if(!file.startsWith(resolve(ctx.cwd)+sep))throw new Error("Non-private barrier");
   appendFileSync(${JSON.stringify(join(base, "tools.jsonl"))},JSON.stringify({session:ctx.sessionManager.getSessionFile(),gate:args.gate})+"\\n");
   while(!existsSync(file))await sleep(50,undefined,{signal});
   return {content:[{type:"text",text:"gate released"}],details:undefined};
  }});
}
`);
  const piVersion = execFileSync(process.execPath, [piCLI, "--version"], { encoding: "utf8" }).trim();
  assert.equal(piVersion, "1.1.0", "Use the repository's real Pi 1.1.0, not a global CLI.");
  console.log(`${execFileSync(realHerdr, ["--version"], { encoding: "utf8" }).trim()} / pi ${piVersion}; private server ${server}`);
  // Refuse an existing server, including if the probe fails for an unexpected reason.
  await assert.rejects(cli(["agent", "list"]), (error: any) => {
    for (const output of [error.stdout, error.stderr]) {
      try { if (JSON.parse(output).error?.code === "server_not_running") return true; } catch {}
    }
    return false;
  });
  daemon = spawn(realHerdr, ["--session", server, "server"], { env: privateEnv, stdio: "pipe" });
  ownsServer = true;
  let daemonLog = "";
  daemon.stdout?.on("data", data => { daemonLog += data; });
  daemon.stderr?.on("data", data => { daemonLog += data; });
  daemon.on("error", error => { daemonLog += String(error); });
  await wait(() => cli(["agent", "list"]), `private server startup: ${daemonLog}`);
  assert.equal((await live()).length, 0);
  const parent = await cli(["workspace", "create", "--no-focus", "--label", "session-e2e-parent", "--cwd", project]);
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: parent.root_pane.pane_id, HERDR_WORKSPACE_ID: parent.workspace.workspace_id, HERDR_TAB_ID: parent.tab.tab_id });
  await sleep(300); // The newly created shell must reach its interactive prompt.

  // The herdr agent name follows the agent across a cross-workspace move (its pane id changes).
  const normal = await launch("normal-child", { prompt: plan("normal-initial", "normal-release") });
  const normalWatch = watch(normal.agent, normal.file);
  await wait(() => normalWatch.ticks.some(t => t.status === "working"), "normal child working");
  const normalPane = await moved(normal.surface, "normal-moved");
  await wait(() => normalWatch.ticks.some(t => t.pane === normalPane && t.status === "working"), "watcher follows the moved pane by name");
  const busyMessage = publishInboxMessage(normal.file, `${plan("steered-after-move")}\nA second line after moving the pane.`);
  await wait(() => entries(join(base, "inputs.jsonl")).some(e => e.session === normal.file && e.text.includes("steered-after-move") && !e.idle), "child submitted multi-line busy steer");
  await wait(() => !existsSync(busyMessage), "the receipt goes once Pi has queued or started the busy steer");
  writeFileSync(join(project, "normal-release"), "released");
  await wait(() => received(normal.file, "steered-after-move"), "steering by name reached the moved agent");
  assert.deepEqual(await normalWatch.result, { reason: "done", exitCode: 0, summary: "RESULT:steered-after-move" });
  assert.ok(answered(normal.file, "RESULT:steered-after-move"));
  assert.equal(existsSync(busyMessage), false);
  assert.ok(received(normal.file, "A second line after moving the pane."));
  // pi exited and left its pane at a shell prompt; the parent closes the last observed pane.
  await closeSurface(normalWatch.ticks.at(-1)!.pane!);
  await gone(normalPane);
  console.log("PASS: start, name-based supervision and steering across a move, parent closes the finished pane");

  // Closing an autonomous subagent's pane mid-task ends it early: a failure, never a success.
  const cancelled = await launch("cancel-child", { prompt: plan("cancel", "cancel-release") });
  const cancelWatch = watch(cancelled.agent, cancelled.file);
  await wait(() => cancelWatch.ticks.some(t => t.status === "working"), "cancel child working");
  await closeSurface(cancelled.surface);
  await gone(cancelled.surface);
  const cancellation = await cancelWatch.result;
  assert.ok(["quit", "interrupted"].includes(cancellation.reason), JSON.stringify(cancellation));
  assert.equal(cancellation.exitCode, 1);
  console.log(`PASS: closing a running autonomous subagent's pane reports failure (${cancellation.reason})`);

  // ── Real extension: spawn → finish → resume by name ──

  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "e2e-scout.md"), [
    "---", "name: e2e-scout", "description: e2e read-only scout",
    "tools: -edit,-write,+session_e2e_gate", "system-prompt: append", "auto-exit: true", "---",
    // A multi-line body, like the example agents': herdr refuses arguments with line breaks.
    "E2E_IDENTITY_MARKER: you are a read-only scout.", "", "## Rules", "- Read files; never modify them.", "",
  ].join("\n"));
  const parentSession = join(project, "parent.jsonl");
  writeFileSync(parentSession, JSON.stringify({ type: "session", id: "parent-e2e", version: 3, cwd: project, timestamp: new Date().toISOString() }) + "\n");
  const ext = await import("../pi-extension/subagents/index.ts");
  // herdr names become reusable once Pi exits; the replacement is not this run.
  const original = await launch("identity-reuse", { prompt: plan("identity-original") });
  await watch(original.agent, original.file).result;
  await wait(async () => !(await live()).some(a => a.name === original.agent), "original name released");
  const replacement = await launch("identity-reuse", { autoExit: false, sessionFile: join(project, "identity-replacement.jsonl") });
  assert.equal(replacement.agent, original.agent, "the private server reused the name");
  const staleWatch = watch(original.agent, original.file);
  assert.equal((await staleWatch.result).reason, "done");
  assert.deepEqual(staleWatch.ticks, [], "replacement state/pane was never reported");
  const stale: any = { id: "stale-identity", name: "stale", task: "old task", herdrName: original.agent,
    surface: original.surface, sessionFile: original.file, startTime: Date.now(), interactive: false };
  await ext.__test__.watchSubagent(stale, new AbortController().signal);
  assert.ok((await live()).some(a => a.name === replacement.agent && a.pane_id === replacement.surface), "completion did not close the replacement");
  // Once session ownership differs, leave the last-known pane for inspection too.
  assert.ok((await cli(["pane", "get", original.surface])).pane);
  await closeSurface(original.surface);
  await closeSurface(replacement.surface);
  console.log("PASS: reused herdr name with another session is never adopted, reported or closed");

  const completed = await launch("same-pane-reuse", { prompt: plan("completed-before-reuse") });
  await watch(completed.agent, completed.file).result;
  await wait(async () => !(await live()).some(a => a.name === completed.agent), "completed Pi exit");
  const replacementFile = join(project, "same-pane-replacement.jsonl");
  await cli(["agent", "start", completed.agent, "--kind", "pi", "--pane", completed.surface, "--",
    "--session", replacementFile, "--offline", "--no-mcp", "--no-themes", "--no-approve",
    "-e", integration, "-e", fixture, "--model", "session-e2e/scripted"]);
  await wait(async () => (await live()).some(a => a.agent_session?.value === replacementFile), "replacement session reported");
  const completedResult = await ext.__test__.watchSubagent({ ...stale, id: "completed-reused-pane", herdrName: completed.agent,
    surface: completed.surface, sessionFile: completed.file }, new AbortController().signal);
  assert.equal(completedResult.summary, "RESULT:completed-before-reuse");
  assert.ok((await live()).some(a => a.pane_id === completed.surface && a.agent_session?.value === replacementFile), "completion must not kill the new session in the same pane");
  await closeSurface(completed.surface);
  console.log("PASS: a completion receipt never closes a pane taken over by another session");

  const tools: any[] = [], delivered: any[] = [];
  ext.default({
    on() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    sendUserMessage() {}, sendMessage(message: any) { delivered.push(message); }, getAllTools() { return []; }, getThinkingLevel() { return "off"; },
  } as any);
  const tool = (name: string) => tools.find(t => t.name === name);
  const ctx = { cwd: project, model: { provider: "session-e2e", id: "scripted" }, sessionManager: { getSessionFile: () => parentSession, getSessionDir: () => join(project, "parent-sessions"), getSessionId: () => "parent-e2e" } };
  const finished = (tag: string) => wait(() => delivered.find(m => JSON.stringify(m).includes(`RESULT:${tag}`)), `result ${tag} delivered`, 60_000);
  const requestsFor = (file: string) => entries(join(base, "requests.jsonl")).filter(r => resolve(r.session) === resolve(file));
  const spawned = await tool("subagent").execute("call-1", { name: "resumable", agent: "e2e-scout", task: plan("first-run") }, undefined, undefined, ctx);
  assert.equal(spawned.details?.error, undefined, JSON.stringify(spawned));
  const launchCall = audit().find(call => call.args[0] === "agent" && call.args[1] === "start" && call.args.includes(spawned.details.sessionFile));
  assert.equal(launchCall.args[launchCall.args.indexOf("--model") + 1], "session-e2e/scripted", "launch inherits the current parent model");
  assert.equal(launchCall.args[launchCall.args.indexOf("--thinking") + 1], "off");
  await finished("first-run");
  const childFile = ext.__test__.runningSubagents.size === 0
    ? JSON.parse(readFileSync(join(project, "parent-sessions", "artifacts", "parent-e2e", "subagent-registry.json"), "utf8")).resumable.sessionFile
    : assert.fail("child still tracked after completion");
  // The parent closes the finished child's pane (it is labelled with the subagent name).
  await wait(async () => !(await cli(["pane", "list"])).panes.some((pane: any) => pane.label === "resumable"), "finished child pane closed by the parent");
  const first = requestsFor(childFile);
  assert.ok(first.length > 0, "first run reached the model");
  assert.ok(first.every(r => r.identity), "profile identity reached the model on first run");
  assert.deepEqual(first.at(-1).tools, ["ask_question", "read", "bash", "session_e2e_gate"].sort());

  const resumed = await tool("subagent_message").execute("call-2", { name: "resumable", message: plan("after-resume") }, undefined, undefined, ctx);
  assert.equal(resumed.details?.error, undefined, JSON.stringify(resumed));
  await finished("after-resume");
  const afterResume = requestsFor(childFile).slice(first.length);
  assert.ok(afterResume.length > 0, "resume reached the model");
  assert.ok(afterResume.every(r => r.identity), "identity survives resume: " + JSON.stringify(afterResume));
  assert.deepEqual(afterResume.at(-1).tools, first.at(-1).tools, "tool restriction survives resume");

  // A child exits before it reads the inbox: the waiting tool resumes with it once.
  const unread = await tool("subagent").execute("unread-start", { name: "unread", agent: "e2e-scout", task: plan("unread-first", "unread-release") }, undefined, undefined, ctx);
  const unreadFile = unread.details.sessionFile;
  await wait(() => entries(join(base, "tools.jsonl")).some(e => e.session === unreadFile && e.gate === "unread-release"), "unread child busy");
  writeFileSync(unreadFile + ".test-refuse-input", "{}");
  const unreadWaiting = tool("subagent_message").execute("unread-message", { name: "unread", message: `${plan("unread-resume")}\nCarry this line through resume.` }, undefined, undefined, ctx);
  await wait(() => pendingInboxMessages(unreadFile).length === 1, "message published but unread");
  assert.equal(received(unreadFile, "unread-resume"), false);
  await closeSurface(unread.details.pane);
  rmSync(unreadFile + ".test-refuse-input");
  assert.equal((await unreadWaiting).details.status, "started", "unread message resumed after watcher completion");
  await finished("unread-resume");
  assert.equal(entries(unreadFile).filter(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("unread-resume")).length, 1);
  assert.deepEqual(pendingInboxMessages(unreadFile), []);
  assert.ok(received(unreadFile, "Carry this line through resume."));
  console.log("PASS: child exits with an unread steer; waiting tool resumes with it exactly once");

  // Escape cancels the parent's waiting tool, not the child watcher or its queued message.
  const escapable = await tool("subagent").execute("escape-start", { name: "escape-wait", agent: "e2e-scout", task: plan("escape-first", "escape-release") }, undefined, undefined, ctx);
  const escapeFile = escapable.details.sessionFile;
  await wait(() => entries(join(base, "tools.jsonl")).some(e => e.session === escapeFile && e.gate === "escape-release"), "Escape child busy");
  writeFileSync(escapeFile + ".test-refuse-input", "{}");
  const escape = new AbortController();
  const escapeWaiting = tool("subagent_message").execute("escape-message", { name: "escape-wait", message: plan("after-escape") }, escape.signal, undefined, ctx);
  await wait(() => pendingInboxMessages(escapeFile).length === 1, "Escape message published");
  escape.abort();
  await assert.rejects(escapeWaiting, /abort/i);
  assert.equal(pendingInboxMessages(escapeFile).length, 1);
  assert.ok([...ext.__test__.runningSubagents.values()].some(child => child.sessionFile === escapeFile));
  rmSync(escapeFile + ".test-refuse-input");
  await wait(() => entries(join(base, "inputs.jsonl")).some(e => e.session === escapeFile && e.text.includes("after-escape") && !e.idle), "published message submitted after Escape");
  writeFileSync(join(project, "escape-release"), "released");
  await finished("after-escape");
  assert.deepEqual(pendingInboxMessages(escapeFile), []);
  console.log("PASS: Escape stops the waiting tool; supervision and queued delivery continue");

  // A follow-up waits until the first task, including its private tool, has finished.
  const followFirst = await tool("subagent_message").execute("follow-start", { name: "resumable", message: plan("follow-first", "follow-release") }, undefined, undefined, ctx);
  await wait(() => entries(join(base, "tools.jsonl")).some(e => e.session === childFile && e.gate === "follow-release"), "follow-up child busy");
  await wait(() => [...ext.__test__.runningSubagents.values()].some(child => child.name === "resumable" && child.status === "working"), "follow-up state reported");
  const listed = await tool("subagents_list").execute("list-runs", {}, undefined, undefined, ctx);
  assert.ok(listed.details.agents.some((agent: any) => agent.name === "e2e-scout"));
  assert.equal(listed.details.running, undefined);
  writeFileSync(childFile + ".test-refuse-input", "{}");
  const followWaiting = tool("subagent_message").execute("follow-message", { name: "resumable", message: plan("follow-next") }, undefined, undefined, ctx);
  const followFile = await wait(() => pendingInboxMessages(childFile)[0], "follow-up file published");
  for (const file of [followFile, childFile + ".loadout.json", childFile + ".identity.md"]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(childFile + ".inbox").mode & 0o777, 0o700);
  rmSync(childFile + ".test-refuse-input");
  await wait(() => entries(join(base, "inputs.jsonl")).some(e => e.session === childFile && e.text.includes("follow-next") && !e.idle), "follow-up queued while busy");
  writeFileSync(join(project, "follow-release"), "released");
  assert.equal((await followWaiting).details.status, "steered");
  await finished("follow-next");
  const followEntries = entries(childFile);
  const nextInput = followEntries.findIndex(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("follow-next"));
  assert.ok(nextInput >= 0, "plain steer reaches the current conversation");
  assert.equal(followFirst.details.sessionFile, childFile);
  console.log("PASS: busy subagent_message uses a plain steer; private sidecars");

  // Control: a bare resume really loses both, so the checks above have teeth.
  const bare = await startAgent({
    name: "bare-resume", cwd: project,
    env: { PI_SUBAGENT_SESSION: childFile, PI_SUBAGENT_NAME: "bare-resume", PI_SUBAGENT_AUTO_EXIT: "1" },
    args: ["--session", childFile, "-e", done],
  });
  publishInboxMessage(childFile, plan("bare-resume"));
  await watch(bare.agent, childFile).result;
  const bareRequests = requestsFor(childFile).filter(request => !request.identity);
  assert.ok(bareRequests.length > 0);
  assert.equal(bareRequests.at(-1).identity, false, "bare resume drops the identity");
  assert.ok(bareRequests.at(-1).tools.includes("write"), "bare resume restores default tools");
  await closeSurface(bare.surface);
  await gone(bare.surface);
  console.log("PASS: real extension spawn+resume keeps identity and tools and closes finished panes; bare resume control loses them");

  // Optional failure coverage; launch.args also permits future CLI/start-failure probes.
  if (originalEnv.PI_SESSION_E2E_ERRORS === "1") {
    const failed = await launch("error-child", { prompt: plan("error", undefined, "SESSION_E2E_PROVIDER_ERROR") });
    const failure = await watch(failed.agent, failed.file).result;
    assert.equal(failure.reason, "error"); assert.match(failure.errorMessage!, /SESSION_E2E_PROVIDER_ERROR/);
    await closeSurface(failed.surface);
    await gone(failed.surface);
    console.log("PASS: provider error sidecar");
  }
  assert.equal(audit().some(call => call.args[0] === "agent" && call.args[1] === "prompt"), false, "all messaging bypasses the terminal");
  console.log(`PASS: isolated session e2e (${server})`);
} catch (error) {
  if (ownsServer) {
    try {
      console.error("Private agents:", JSON.stringify(await live()));
      const panes = (await cli(["pane", "list"])).panes;
      for (const pane of panes) console.error(pane.pane_id, await cli(["pane", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "30"], true));
    } catch {}
  }
  throw error;
} finally {
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(watches);
  try {
    if (ownsServer) {
      // Stop only our literal named server. No workspace/pane cleanup targets caller state.
      await cli(["session", "stop", server], true);
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        await new Promise<void>((resolveExit, reject) => {
          const timer = setTimeout(() => reject(new Error("Owned herdr server did not stop")), 10_000);
          daemon!.once("exit", () => { clearTimeout(timer); resolveExit(); });
        });
      }
      await cli(["session", "delete", server], true);
    }
  } finally {
    // Never kill an inherited herdr process; this handle belongs solely to spawn above.
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(base, { recursive: true, force: true });
  }
}
