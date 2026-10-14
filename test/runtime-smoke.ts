// Real Pi 1.1.0 CLI runtime smoke tests; all model traffic is localhost-only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pendingQuestions, pendingInboxMessages, publishInboxMessage } from "../pi-extension/subagents/session.ts";

const root = mkdtempSync(join(tmpdir(), "pi-runtime-smoke-"));
const doneExtension = resolve("pi-extension/subagents/subagent-done.ts");
const cli = resolve("node_modules/.bin/pi");
const requests: any[] = [];
let replies: any[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const reply = replies.shift() ?? { text: "SIMULATED_OK" };
  if (reply.delay) await delay(reply.delay);
  if (res.destroyed) return;
  res.writeHead(reply.status ?? 200, { "Content-Type": reply.status ? "application/json" : "text/event-stream" });
  if (reply.status) return res.end(JSON.stringify({ error: { message: reply.message ?? "SIMULATED_PROVIDER_ERROR", type: "server_error" } }));
  const delta = reply.tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] } : { role: "assistant", content: reply.text ?? "SIMULATED_OK" };
  const chunk = (d: any, finish_reason: string | null) => ({ id: "sim", object: "chat.completion.chunk", created: 1, model: "sim-model", choices: [{ index: 0, delta: d, finish_reason }] });
  res.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, reply.tool ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const children = new Set<ReturnType<typeof spawn>>();
let serial = 0;

async function waitFor(check: () => any, detail: () => string, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = check(); if (value) return value; await delay(10); }
  throw new Error(`Timed out: ${detail()}`);
}
function start(opts: { tools?: string; toolArgs?: string[]; extensions?: string[]; beforeExtensions?: string[]; autoRetry?: boolean; retryDelay?: number; terminal?: boolean; initialTask?: string; session?: string; model?: string | null; skillNames?: string; configure?: (dir: string, config: string) => void } = {}) {
  requests.length = 0; replies = [];
  const dir = join(root, String(++serial)); mkdirSync(join(dir, "config"), { recursive: true });
  const config = join(dir, "config");
  writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { simulation: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: "sim-model", name: "sim-model", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { id: "sim-model-2", name: "sim-model-2", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: opts.autoRetry ?? false, maxRetries: 1, baseDelayMs: opts.retryDelay ?? 30, maxDelayMs: opts.retryDelay ?? 30 }, compaction: { enabled: false } }));
  opts.configure?.(dir, config);
  const session = opts.session ?? join(dir, "session.jsonl");
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SUBAGENT_SESSION: session, PI_SUBAGENT_NAME: "smoke", PI_SUBAGENT_AGENT: "scout", PI_SUBAGENT_AUTO_EXIT: "1" };
  // Never inherit the harness's real pane or herdr executable.
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_") || key.startsWith("PI_SESSION_") || key === "PI_DENY_TOOLS" ||
        (key.startsWith("PI_SUBAGENT_") && !["PI_SUBAGENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_AGENT", "PI_SUBAGENT_AUTO_EXIT"].includes(key))) delete (env as any)[key];
  }
  if (opts.skillNames) (env as any).PI_SUBAGENT_SKILLS = opts.skillNames;
  const args = [...(opts.terminal ? ["--tui-mode", "regular"] : ["--mode", "rpc"]), "--no-themes", "--session", session];
  // null leaves the model to the loadout args or, on resume, to the session.
  if (opts.model !== null) args.push("--model", opts.model ?? "simulation/sim-model");
  for (const ext of [...(opts.beforeExtensions ?? []), doneExtension, ...(opts.extensions ?? [])]) args.push("-e", ext);
  if (opts.tools) args.push("--tools", opts.tools);
  if (opts.toolArgs) args.push(...opts.toolArgs);
  if (opts.initialTask) publishInboxMessage(session, opts.initialTask);
  const command = "exec " + [cli, ...args].map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
  const child = opts.terminal
    ? spawn("script", ["-qef", "-E", "never", "/dev/null", "-c", command], { cwd: dir, env: { ...env, SHELL: "/bin/sh", TERM: "xterm-256color" }, stdio: "pipe" })
    : spawn(cli, args, { cwd: dir, env, stdio: "pipe" }); children.add(child);
  const records: any[] = []; let buffer = "", stderr = "", terminalOutput = "", closed = false, code: number | null = null; let id = 0;
  child.stdout!.setEncoding("utf8").on("data", data => { if (opts.terminal) { terminalOutput += data; return; } buffer += data; let end; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) try { records.push(JSON.parse(line)); } catch { stderr += line; } } });
  child.stderr!.setEncoding("utf8").on("data", d => stderr += d);
  child.stdin!.on("error", () => {}); child.on("close", c => { closed = true; code = c; children.delete(child); });
  const diagnostic = () => stderr + (opts.terminal ? terminalOutput.slice(-1000) : JSON.stringify(records.slice(-5).map(r => ({ type: r.type, error: r.error, message: r.message?.errorMessage }))));
  const send = (type: string, params: any = {}) => { const key = String(++id); child.stdin!.write(JSON.stringify({ id: key, type, ...params }) + "\n"); return key; };
  return { dir, session, records, diagnostic, get closed() { return closed; }, send,
    async command(type: string, params: any = {}) { const key = send(type, params); return waitFor(() => records.find(r => r.type === "response" && r.id === key), diagnostic); },
    // Call only when this test expects autonomous completion, never for a parked question or abort.
    // The helper requests shutdown while Pi forwards agent_settled, so pi exits by itself.
    async exited(expectedSettlements = 1) {
      if (!opts.terminal) await waitFor(() => records.filter(r => r.type === "agent_settled").length >= expectedSettlements, diagnostic);
      await waitFor(() => closed, diagnostic);
      assert.equal(code, 0, diagnostic());
    },
    async stop() { if (!closed) child.stdin!.end(); await waitFor(() => closed, diagnostic); assert.equal(code, 0, diagnostic()); },
    sidecar(suffix: string) { try { return JSON.parse(readFileSync(session + suffix, "utf8")); } catch { return null; } },
    tools() { return requests[0]?.tools?.map((t: any) => t.function.name) ?? []; },
  };
}
const prompt = (h: ReturnType<typeof start>, message = "DO_TASK") => publishInboxMessage(h.session, message);
const sessionEntries = (h: ReturnType<typeof start>) => readFileSync(h.session, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const lastAssistant = (h: ReturnType<typeof start>) => sessionEntries(h).filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1)?.message;
const userTexts = (messages: any[]) => messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"));
after(async () => { for (const child of children) child.kill("SIGKILL"); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); });

test("Pi 1.1 modifier loadout retains defaults, adds codemode and excludes bash; allowlist includes helper", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const allow = testApi.buildSubagentToolAllowlist("+codemode,-bash");
  const childArgs: string[] = [];
  testApi.applyLoadoutToArgs(childArgs, { toolAllowlist: allow }, join(root, "modifier.jsonl"));
  const h = start({ toolArgs: childArgs });
  await h.command("get_state"); prompt(h); await h.exited();
  assert.deepEqual(h.tools().sort(), ["ask_question", "codemode", "edit", "read", "write"].sort());
  assert.equal(testApi.buildSubagentToolAllowlist("read"), "read,ask_question");
  assert.deepEqual(allow, "+codemode,-bash,+ask_question");
});

test("resume replays the loadout snapshot; a bare resume would drop identity and tools", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const identity = "IDENTITY_MARKER: you are a read-only scout.";
  const loadout = { agent: "scout", toolAllowlist: testApi.buildSubagentToolAllowlist("read"),
    systemPromptMode: "append" as const, identity, spawnable: null, cwd: null, agentDir: null };
  const launchArgs: string[] = [];
  testApi.applyLoadoutToArgs(launchArgs, loadout, join(root, "append-identity.jsonl"));
  const first = start({ toolArgs: launchArgs });
  await first.command("get_state"); prompt(first); await first.exited();
  const session = first.session;
  const lastRequest = () => JSON.stringify(requests.at(-1)?.messages ?? []);
  const lastTools = () => requests.at(-1)?.tools?.map((t: any) => t.function.name).sort() ?? [];
  assert.match(lastRequest(), /IDENTITY_MARKER/);
  assert.deepEqual(lastTools(), ["ask_question", "read"]);

  const resumeArgs: string[] = [];
  testApi.applyLoadoutToArgs(resumeArgs, loadout, join(root, "append-identity.jsonl"));
  const resumed = start({ session, toolArgs: resumeArgs });
  await resumed.command("get_state"); prompt(resumed, "CONTINUE"); await resumed.exited();
  assert.match(lastRequest(), /IDENTITY_MARKER/, "replayed resume keeps the identity");
  assert.deepEqual(lastTools(), ["ask_question", "read"], "replayed resume keeps the tool restriction");

  // Control: Pi patches the session to the current flags, so a bare resume loses both.
  const bare = start({ session });
  await bare.command("get_state"); prompt(bare, "CONTINUE_BARE"); await bare.exited();
  assert.doesNotMatch(lastRequest(), /IDENTITY_MARKER/);
  assert.ok(lastTools().includes("bash"), lastTools().join(","));
});

test("resume keeps a replace-mode identity and the session's later model/thinking switch", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const loadout = {
    toolAllowlist: testApi.buildSubagentToolAllowlist("read"), systemPromptMode: "replace",
    identity: "REPLACE_MARKER: you are a read-only scout.",
  };
  const launchArgs: string[] = [];
  testApi.applyLoadoutToArgs(launchArgs, loadout, join(root, "replace-identity.jsonl"));
  const first = start({ model: "simulation/sim-model", toolArgs: launchArgs });
  await first.command("get_state");
  // The subagent switches model and thinking mid-session; resume must not undo it.
  assert.equal((await first.command("set_model", { provider: "simulation", modelId: "sim-model-2" })).success, true);
  assert.equal((await first.command("set_thinking_level", { level: "high" })).success, true);
  prompt(first); await first.exited();
  const defaultPreamble = /You are an expert coding assistant/;
  const lastRequest = () => JSON.stringify(requests.at(-1)?.messages ?? []);
  assert.match(lastRequest(), /REPLACE_MARKER/);
  assert.doesNotMatch(lastRequest(), defaultPreamble);

  const resumeArgs: string[] = [];
  testApi.applyLoadoutToArgs(resumeArgs, loadout, join(root, "replace-identity.jsonl"));
  assert.equal(resumeArgs.includes("--model"), false);
  const resumed = start({ session: first.session, model: null, toolArgs: resumeArgs });
  const state = (await resumed.command("get_state")).data;
  assert.equal(state.model?.id, "sim-model-2", JSON.stringify(state.model));
  assert.equal(state.thinkingLevel, "high");
  prompt(resumed, "CONTINUE"); await resumed.exited();
  assert.equal(requests.at(-1)?.model, "sim-model-2");
  assert.match(lastRequest(), /REPLACE_MARKER/);
  assert.doesNotMatch(lastRequest(), defaultPreamble, "replace mode survives resume");
});

test("an append-mode identity reaches every request, also of a run a subagent's result starts", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const identityArgs: string[] = [];
  testApi.applyLoadoutToArgs(identityArgs, { systemPromptMode: "append", identity: "IDENTITY_MARKER: you are a worker.\n\nKeep going." }, join(root, "worker-identity.jsonl"));
  // Stands in for a delegated child: keeps the worker open, then its result starts another run.
  const child = join(root, "child-result.ts");
  writeFileSync(child, `export default (pi:any)=>{let pending=true;(globalThis as any)[Symbol.for("pi-subagents/running-children-count")]=()=>pending?1:0;
    pi.on("agent_settled",()=>{if(!pending)return;pending=false;setTimeout(()=>pi.sendMessage({customType:"subagent_result",content:"CHILD_RESULT",display:true},{triggerTurn:true,deliverAs:"steer"}),10);});};`);
  const h = start({ toolArgs: identityArgs, extensions: [child] });
  await h.command("get_state");
  replies = [{ text: "DISPATCHED" }, { tool: "read", args: { path: "missing.txt" } }, { text: "DONE" }];
  prompt(h); await h.exited(2);
  assert.equal(requests.length, 3, h.diagnostic());
  for (const [index, request] of requests.entries()) assert.match(JSON.stringify(request.messages), /IDENTITY_MARKER/, `request ${index}`);
});

test("a prompt survives a child's result starting a run while an earlier input handler prepares it", async () => {
  // Loaded before this package's extension: a slow input handler (like inline-bash running a
  // command), during which a child's result arrives and starts a run.
  const slow = join(root, "slow-input.ts");
  writeFileSync(slow, `export default (pi:any)=>{let once=false;pi.on("input",async(e:any)=>{if(e.text!=="USER_TASK"||once)return;once=true;
    pi.sendMessage({customType:"subagent_result",content:"CHILD_RESULT",display:true},{triggerTurn:true,deliverAs:"steer"});
    await new Promise(r=>setTimeout(r,300));});};`);
  const extension = resolve("pi-extension/subagents/index.ts");
  const h = start({ extensions: [slow, extension] });
  await h.command("get_state");
  replies = [{ delay: 1000, text: "ON_THE_RESULT" }, { text: "BOTH_SEEN" }];
  prompt(h, "USER_TASK");
  await h.exited();
  assert.match(JSON.stringify(requests), /USER_TASK/, "the submitted prompt reached the model");
  assert.match(JSON.stringify(requests), /CHILD_RESULT/);
});

test("YAML quoted/list tools become a real CLI loadout", async () => {
  const config = join(root, "yaml-agent-config"); const cwd = join(root, "yaml-project");
  mkdirSync(join(config, "agents"), { recursive: true }); mkdirSync(cwd, { recursive: true });
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  for (const [yaml, expectedDefinition, expectedTools] of [
    ['tools: "read"', "read", ["ask_question", "read"]],
    ['tools:\n  - "+codemode"\n  - "-bash"', ["+codemode", "-bash"], ["ask_question", "codemode", "edit", "read", "write"]],
  ] as const) {
    writeFileSync(join(config, "agents/scout.md"), `---\nname: scout\n${yaml}\n---\nYAML_ROLE_MARKER\n`);
    const previousCwd = process.cwd(), previousConfig = process.env.PI_CODING_AGENT_DIR;
    let definition: any;
    try {
      process.chdir(cwd); process.env.PI_CODING_AGENT_DIR = config;
      definition = testApi.loadAgentDefaults("scout");
    } finally {
      process.chdir(previousCwd);
      if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousConfig;
    }
    assert.deepEqual(definition.tools, expectedDefinition);
    const childArgs: string[] = [];
    testApi.applyLoadoutToArgs(childArgs, { toolAllowlist: testApi.buildSubagentToolAllowlist(definition.tools) }, join(root, "yaml.jsonl"));
    const h = start({ toolArgs: childArgs }); await h.command("get_state"); prompt(h); await h.exited();
    // Provider declarations prove plain read is a true allowlist, not merely a helper string assertion.
    assert.deepEqual(h.tools().sort(), [...expectedTools].sort());
  }
});

test("RPC asks a question without auto-exit; answer permits settled completion", async () => {
  const h = start(); await h.command("get_state");
  replies = [{ tool: "ask_question", args: { question: "Which option?" } }, { text: "ANSWERED" }]; prompt(h);
  await waitFor(() => pendingQuestions(h.session).questions.length > 0 && h.records.some(r => r.type === "agent_settled"), h.diagnostic);
  const askEntries = readFileSync(h.session, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  const persistedAsk = askEntries.filter(entry => entry.type === "message" && entry.message.role === "assistant")
    .flatMap(entry => entry.message.content ?? []).find(part => part.type === "toolCall" && part.name === "ask_question");
  assert.ok(persistedAsk, "the question is already durably represented by Pi's native tool call");
  assert.equal(persistedAsk.arguments.question, "Which option?");
  // Let the settled exit timer run while parked. Do not send get_state (or end stdin) to manufacture an exit.
  await delay(100); assert.equal(h.closed, false, h.diagnostic()); assert.equal(h.sidecar(".exit"), null);
  assert.equal(requests.length, 2); assert.deepEqual(pendingQuestions(h.session).questions, ["Which option?"]);
  prompt(h, "CHOOSE A\nwith a multi-line reply"); await h.exited(2);
  assert.equal(requests.length, 3); assert.match(JSON.stringify(requests[2].messages), /CHOOSE A/); assert.equal(lastAssistant(h).stopReason, "stop"); assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "SIMULATED_OK" });
});

test("busy Pi takes an inbox message as a steer before settled auto-exit", async () => {
  const h = start(); await h.command("get_state"); replies = [{ delay: 1000 }, { text: "STEER_DONE" }]; prompt(h);
  await waitFor(() => requests.length === 1, h.diagnostic);
  const file = prompt(h, "BUSY_STEER\nsecond line");
  await waitFor(() => !pendingInboxMessages(h.session).includes(file), h.diagnostic);
  await h.exited(); assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /BUSY_STEER\\nsecond line/);
  assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "STEER_DONE" });
});

test("an earlier input extension can prepend and append context without replaying an inbox delivery", async () => {
  const transform = join(root, "append-context.ts");
  writeFileSync(transform, `export default (pi:any)=>pi.on("input",(event:any)=>({action:"transform",text:"PREPENDED_CONTEXT\\n"+event.text+"\\nAPPENDED_CONTEXT"}));`);
  const h = start({ beforeExtensions: [transform] });
  await h.command("get_state");
  const file = prompt(h, "TRANSFORMED_TASK");
  await h.exited();
  assert.equal(existsSync(file), false, "submitted input no longer needs an inbox file");
  assert.deepEqual(pendingInboxMessages(h.session), []);
  assert.equal(requests.length, 1, "no repeated task after settlement");
  const expected = ["PREPENDED_CONTEXT\nTRANSFORMED_TASK\nAPPENDED_CONTEXT"];
  assert.deepEqual(userTexts(requests[0].messages), expected);
  assert.deepEqual(userTexts(sessionEntries(h).filter(entry => entry.type === "message").map(entry => entry.message)), expected);
  assert.doesNotMatch(JSON.stringify(requests), /subagent-delivery:/);
});

test("a busy inbox message steers the current run, including while tools are running", async () => {
  const h = start(); await h.command("get_state");
  replies = [{ delay: 1000, tool: "read", args: { path: "missing.txt" } }, { text: "STEERED_DONE" }];
  prompt(h);
  await waitFor(() => requests.length === 1, h.diagnostic);
  publishInboxMessage(h.session, "AFTER_CURRENT_WORK\nsecond line");
  await h.exited();
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /AFTER_CURRENT_WORK/);
  assert.deepEqual(pendingInboxMessages(h.session), []);
  assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "STEERED_DONE" });
});

test("Escape stops the waiting tool, not supervision or the published inbox message", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const h = start(); await h.command("get_state");
  replies = [{ delay: 1500 }, { text: "AFTER_ESCAPE" }]; prompt(h);
  await waitFor(() => requests.length === 1, h.diagnostic);
  const child: any = { id: "runtime-wait", name: "runtime-wait", sessionFile: h.session,
    watching: waitFor(() => h.closed, h.diagnostic) };
  testApi.runningSubagents.set(child.id, child);
  try {
    const escape = new AbortController();
    const waiting = testApi.steerLive(child, "MESSAGE_AFTER_ESCAPE\nsecond line", escape.signal);
    escape.abort(); // cancel in the same tick, without waiting for submission
    await assert.rejects(waiting, /abort/i);
    assert.equal(testApi.runningSubagents.has(child.id), true);
    await h.exited();
    assert.deepEqual(pendingInboxMessages(h.session), []);
    const users = sessionEntries(h).filter(e => e.type === "message" && e.message.role === "user");
    assert.equal(users.filter(e => JSON.stringify(e).includes("MESSAGE_AFTER_ESCAPE")).length, 1);
    assert.match(JSON.stringify(requests.at(-1).messages), /MESSAGE_AFTER_ESCAPE\\nsecond line/);
    assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "AFTER_ESCAPE" });
  } finally { testApi.runningSubagents.delete(child.id); }
});

test("agent_before_settle continuation runs before final sidecar", async () => {
  const inject = join(root, "continue.ts"); const log = join(root, "continuations.log"); writeFileSync(inject, `import {appendFileSync} from "node:fs"; export default (pi:any)=>{let once=false;pi.on("agent_before_settle",()=>{appendFileSync(${JSON.stringify(log)},"boundary\\n");if(!once){once=true;pi.sendUserMessage("BOUNDARY_CONTINUATION",{deliverAs:"followUp"})}});};`);
  const h = start({ extensions: [inject] }); await h.command("get_state"); prompt(h); await h.exited();
  assert.ok(readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).length >= 2); assert.ok(requests.length >= 2); assert.match(JSON.stringify(requests), /BOUNDARY_CONTINUATION/); assert.equal(lastAssistant(h).stopReason, "stop"); assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "SIMULATED_OK" });
});

test("abort parks with a .paused sidecar and no .exit", async () => {
  const h = start(); await h.command("get_state"); replies = [{ delay: 500 }]; prompt(h);
  await waitFor(() => requests.length === 1, h.diagnostic); await h.command("abort");
  await waitFor(() => h.records.some(r => r.type === "agent_settled"), h.diagnostic); assert.deepEqual(h.sidecar(".paused"), {}); assert.equal(h.sidecar(".exit"), null); await h.stop();
});

test("retry transient failure does not write exit until successful settled retry", async () => {
  const h = start({ autoRetry: true, retryDelay: 40 }); await h.command("get_state"); replies = [{ status: 429 }, { text: "RECOVERED" }]; prompt(h);
  await waitFor(() => h.records.some(r => r.type === "auto_retry_start"), h.diagnostic);
  await delay(10); assert.equal(h.sidecar(".exit"), null); await h.exited(); assert.equal(requests.length, 2); assert.equal(lastAssistant(h).stopReason, "stop"); assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "RECOVERED" });
});

test("final provider error writes error sidecar after retry exhaustion", async () => {
  const h = start({ autoRetry: true, retryDelay: 10 }); await h.command("get_state"); replies = [{ status: 429, message: "FINAL_SIMULATED_ERROR" }, { status: 429, message: "FINAL_SIMULATED_ERROR" }]; prompt(h);
  await h.exited(); assert.equal(h.sidecar(".exit")?.type, "error"); assert.equal(lastAssistant(h).stopReason, "error"); assert.match(lastAssistant(h).errorMessage, /FINAL_SIMULATED_ERROR/);
});

test("real PTY modifier loadout exits naturally after settled task", async () => {
  const testApi = (await import("../pi-extension/subagents/index.ts")).__test__;
  const args: string[] = [];
  testApi.applyLoadoutToArgs(args, { toolAllowlist: testApi.buildSubagentToolAllowlist("+codemode,-bash") }, join(root, "pty.jsonl"));
  const h = start({ terminal: true, initialTask: "PTY_TASK", toolArgs: args }); await h.exited();
  assert.equal(requests.length, 1); assert.equal(lastAssistant(h).stopReason, "stop"); assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "SIMULATED_OK" });
});

test("real PTY drains agent_end follow-up before naturally exiting", async () => {
  const inject = join(root, "pty-followup.ts");
  writeFileSync(inject, `export default (pi:any)=>{let once=false;pi.on("agent_end",()=>{if(!once){once=true;pi.sendUserMessage("PTY_FOLLOWUP",{deliverAs:"followUp"})}})};`);
  const h = start({ terminal: true, initialTask: "PTY_FIRST_TASK", extensions: [inject] }); await h.exited();
  assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1].messages), /PTY_FOLLOWUP/); assert.equal(lastAssistant(h).stopReason, "stop"); assert.deepEqual(h.sidecar(".exit"), { type: "done", summary: "SIMULATED_OK" });
});
