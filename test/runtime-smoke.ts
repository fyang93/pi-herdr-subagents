// Opt-in: node test/runtime-smoke.ts [pi executable and prefix arguments]
// Uses real pi processes, a localhost model and a fake herdr; never touches real panes.
// Terminal only: node --test --test-name-pattern='terminal:' test/runtime-smoke.ts
// Uses util-linux `script` to provide a real PTY (not RPC).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "pi-subagents-runtime-"));
const extension = resolve("pi-extension/subagents/index.ts");
const cli = process.argv.slice(2);
if (!cli.length) cli.push("pi");
const requests: any[] = [];
let replies: any[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  const reply = replies.shift() ?? { text: "SIMULATED_OK" };
  if (reply.delay) await delay(reply.delay);
  if (res.destroyed) return;
  if (reply.error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "SIMULATED_PROVIDER_ERROR", type: "invalid_request_error" } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = reply.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: "sim-call", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] }
    : { role: "assistant", content: reply.text ?? "SIMULATED_OK" };
  const chunk = (delta: any, finish_reason: string | null) => ({ id: "sim", object: "chat.completion.chunk", created: 1, model: "role-model", choices: [{ index: 0, delta, finish_reason }] });
  res.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, reply.tool ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const port = (server.address() as any).port;
const children = new Set<ReturnType<typeof spawn>>();
let sequence = 0;

async function waitFor(check: () => any, detail: () => string = () => "condition", timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out: ${detail()}`);
}

function start(fields: string | null, body = "ROLE_MARKER", autoExit = false, herdr = false, terminal?: { task?: string; agent?: string }) {
  requests.length = 0;
  replies = [];
  const dir = join(root, String(++sequence));
  const config = join(dir, "config");
  mkdirSync(join(dir, ".pi/agents"), { recursive: true });
  mkdirSync(join(config, "agents"), { recursive: true });
  writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { simulation: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "dummy",
    models: ["base-model", "role-model"].map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const definition = (fields: string, body: string) => `---\nname: host\n${fields}\n---\n${body}\n`;
  writeFileSync(join(config, "agents/host.md"), definition("model: missing/global", "GLOBAL_MARKER"));
  if (fields !== null) writeFileSync(join(dir, ".pi/agents/different-filename.md"), definition(fields, body));
  const log = join(dir, "herdr.log");
  writeFileSync(log, "");
  const fakeHerdr = join(dir, "herdr");
  writeFileSync(fakeHerdr, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n'); console.log(args[0] === 'integration' ? 'pi: current (v1)' : JSON.stringify({ result: { pane: { pane_id: 'sim:current' } } }));\n`);
  chmodSync(fakeHerdr, 0o755);
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", HERDR_BIN_PATH: fakeHerdr };
  for (const key of Object.keys(env)) if (key.startsWith("HERDR_") && key !== "HERDR_BIN_PATH" || key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SESSION_")) delete env[key];
  if (herdr) Object.assign(env, { HERDR_ENV: "1", HERDR_PANE_ID: "sim:original" });
  const roleFlags = fields === null ? [] : ["--subagent-agent", terminal?.agent ?? "host"];
  const args = [...cli, ...(terminal ? [] : ["--mode", "rpc"]), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--session", join(dir, "session.jsonl"), "--model", "simulation/base-model", "-e", extension, ...roleFlags, ...(autoExit ? ["--subagent-exit"] : []), ...(terminal?.task ? ["--", terminal.task] : [])];
  const command = "exec " + args.map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
  const child = terminal
    ? spawn("script", ["-qef", "-E", "never", "/dev/null", "-c", command], { cwd: dir, env: { ...env, SHELL: "/bin/sh", TERM: "xterm-256color" }, stdio: "pipe" })
    : spawn(args[0], args.slice(1), { cwd: dir, env, stdio: "pipe" });
  children.add(child);
  const records: any[] = [];
  let buffer = "", stderr = "", terminalOutput = "", closed = false, code: number | null = null;
  child.stdout!.setEncoding("utf8").on("data", data => {
    if (terminal) { terminalOutput += data; return; }
    buffer += data;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) { try { records.push(JSON.parse(line)); } catch { stderr += line + "\n"; } }
    }
  });
  child.stderr!.setEncoding("utf8").on("data", data => { stderr += data; });
  child.stdin!.on("error", () => {});
  child.on("error", error => { stderr += String(error); });
  child.on("close", value => { closed = true; code = value; children.delete(child); });
  const diagnostic = () => stderr + "\n" + (terminal ? terminalOutput.slice(-2000) : JSON.stringify(records.slice(-4).map(r => ({ type: r.type, message: r.message?.errorMessage ?? (typeof r.message === "string" ? r.message : undefined), error: r.error }))));
  let id = 0;
  return {
    records, log, dir, diagnostic,
    get closed() { return closed; },
    get output() { return terminalOutput; },
    keys(text: string) { child.stdin!.write(text); },
    entries() { try { return readFileSync(join(dir, "session.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    send(type: string, params: any = {}) { const key = String(++id); child.stdin!.write(JSON.stringify({ id: key, type, ...params }) + "\n"); return key; },
    async command(type: string, params: any = {}) {
      const key = this.send(type, params);
      return waitFor(() => records.find(r => r.type === "response" && r.id === key), diagnostic);
    },
    async exited() { await waitFor(() => closed, diagnostic); assert.equal(code, 0, diagnostic()); },
    async stop() { if (!closed) { if (terminal) this.keys("\x03/quit\r"); else child.stdin!.end(); } await this.exited(); },
    calls() { return readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); },
  };
}
const role = "model: simulation/role-model\nthinking: high\ntools: read\nsystem-prompt: append";
const userTexts = (request: any) => request.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
after(async () => {
  for (const child of children) child.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

test("project/hidden role: real model, thinking, prompt, delegation tools and autonomous RPC exit", async () => {
  const h = start(role.replace("tools: read", "tools: read, safe_bash, subagent\nsubagent_agents: scout\ndisable-model-invocation: true"), "ROLE_MARKER", true);
  const state = await h.command("get_state");
  assert.equal(state.data.model.id, "role-model", h.diagnostic());
  assert.equal(state.data.thinkingLevel, "high");
  h.send("prompt", { message: "FIRST_TASK" });
  await h.exited();
  assert.equal(requests.length, 1, h.diagnostic());
  assert.match(JSON.stringify(requests[0].messages), /ROLE_MARKER/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /GLOBAL_MARKER/);
  const names = requests[0].tools.map((t: any) => t.function.name).sort();
  assert.deepEqual(names, ["read", "safe_bash", "subagent", "subagent_message", "subagents_list"].sort());
  assert.match(readFileSync(join(h.dir, "session.jsonl"), "utf8"), /subagent_role/);
});

test("no exit flag: stays open; default body prepends only the first task; no delegation despite named tools", async () => {
  const h = start(role.replace("tools: read", "tools: read, subagent, subagent_message, subagents_list").replace("\nsystem-prompt: append", ""));
  await h.command("get_state");
  h.send("prompt", { message: "FIRST_TASK" });
  await waitFor(() => h.records.some(r => r.type === "agent_end"), h.diagnostic);
  await delay(100); assert.equal(h.closed, false);
  assert.match(userTexts(requests[0]).join("\n"), /ROLE_MARKER[\s\S]*FIRST_TASK/);
  assert.deepEqual(requests[0].tools.map((t: any) => t.function.name), ["read"]);
  h.send("prompt", { message: "SECOND_TASK" });
  await waitFor(() => h.records.filter(r => r.type === "agent_end").length === 2, h.diagnostic);
  assert.equal(userTexts(requests[1]).at(-1), "SECOND_TASK");
  await h.stop();
});

test("replace system prompt and follow-up queue finish before closing only the confirmed fake pane", async () => {
  const h = start(role.replace("append", "replace"), "REPLACEMENT_MARKER", true, true);
  await h.command("get_state");
  replies = [{ delay: 300 }, { text: "FOLLOW_UP_DONE" }];
  h.send("prompt", { message: "FIRST_TASK" });
  await waitFor(() => requests.length === 1, h.diagnostic);
  assert.equal(requests[0].messages[0].content, "REPLACEMENT_MARKER");
  await h.command("follow_up", { message: "QUEUED_TASK" });
  await h.exited();
  assert.equal(requests.length, 2, h.diagnostic());
  assert.match(userTexts(requests[1]).join("\n"), /QUEUED_TASK/);
  await waitFor(() => h.calls().some(c => c[0] === "pane" && c[1] === "close"), h.diagnostic);
  assert.deepEqual(h.calls().filter(c => c[0] === "pane"), [["pane", "current", "--current"], ["pane", "close", "sim:current"]]);
});

test("invalid role configurations reject the host task without a model request or herdr initialization", async () => {
  for (const fields of [null, "model: missing/model", "thinking: turbo", "cli: claude"]) {
    const h = start(fields, "MUST_NOT_RUN", true, true);
    // RPC checks startup shutdown requests at the next command boundary.
    await waitFor(() => h.records.some(r => r.type === "extension_ui_request" && r.notifyType === "error"), h.diagnostic);
    h.send("prompt", { message: "MUST_NOT_RUN" });
    await h.exited();
    assert.equal(requests.length, 0, h.diagnostic());
    assert.deepEqual(h.calls(), [], h.diagnostic());
    assert.match(h.diagnostic(), /requires|unavailable|Invalid thinking|only support/);
  }
});

test("provider error leaves role open; a later successful RPC task can finish", async () => {
  const h = start(role, "ROLE_MARKER", true);
  await h.command("get_state"); replies = [{ error: true }];
  h.send("prompt", { message: "FAIL_TASK" });
  await waitFor(() => h.records.some(r => r.type === "agent_end"), h.diagnostic);
  await delay(100); assert.equal(h.closed, false, h.diagnostic());
  assert.match(JSON.stringify(h.records), /SIMULATED_PROVIDER_ERROR/);
  h.send("prompt", { message: "RECOVER_TASK" });
  await h.exited();
  assert.equal(requests.length, 2);
});

test("abort permanently retains the top-level session, even after a later successful task", async () => {
  const h = start(role, "ROLE_MARKER", true);
  await h.command("get_state"); replies = [{ delay: 500 }];
  h.send("prompt", { message: "ABORT_TASK" });
  await waitFor(() => requests.length === 1, h.diagnostic);
  await h.command("abort");
  h.send("prompt", { message: "AFTER_ABORT_TASK" });
  await waitFor(() => requests.length === 2 && h.records.filter(r => r.type === "agent_end").length === 2, h.diagnostic);
  await delay(100); assert.equal(h.closed, false, h.diagnostic());
  await h.stop();
});

test("real spawn tool rejects forbidden, missing and self roles before touching herdr", async () => {
  for (const [agent, expected] of [["worker", /not in your allowlist/], ["missing", /not in your allowlist/], ["host", /do not start another host/], ["scout", /require herdr/]]) {
    const h = start(role + "\nsubagent_agents: scout, missing", "ROLE_MARKER", true);
    await h.command("get_state");
    replies = [{ tool: "subagent", args: { agent, task: "SIMULATED_CHILD_TASK" } }, { text: "CHECKED" }];
    h.send("prompt", { message: "DISPATCH_TASK" });
    await h.exited();
    assert.equal(requests.length, 2, h.diagnostic());
    const result = requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(JSON.stringify(result), expected as RegExp);
    assert.deepEqual(h.calls(), []);
  }
});

test("real delegation tool execution lists only known allowlisted definitions", async () => {
  const h = start(role + "\nsubagent_agents: scout, missing", "ROLE_MARKER", true);
  await h.command("get_state"); replies = [{ tool: "subagents_list" }, { text: "LIST_CHECKED" }];
  h.send("prompt", { message: "LIST_TASK" });
  await h.exited();
  assert.equal(requests.length, 2, h.diagnostic());
  const result = requests[1].messages.find((m: any) => m.role === "tool");
  assert.match(JSON.stringify(result), /scout/);
  assert.doesNotMatch(JSON.stringify(result), /researcher|worker|missing/);
});

const assistantMessages = (h: ReturnType<typeof start>) => h.entries().filter(e => e.type === "message" && e.message?.role === "assistant").map(e => e.message);

test("terminal: positional task applies project role, model, thinking and tools, then exits", async () => {
  const h = start(role.replace("tools: read", "tools: read, safe_bash\nsubagent_agents: scout"), "ROLE_MARKER", true, true, { task: "CLI INITIAL TASK" });
  await h.exited();
  assert.equal(requests.length, 1, h.diagnostic());
  assert.equal(requests[0].model, "role-model");
  assert.match(userTexts(requests[0]).join("\n"), /CLI INITIAL TASK/);
  assert.match(JSON.stringify(requests[0].messages), /ROLE_MARKER/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /GLOBAL_MARKER/);
  assert.deepEqual(requests[0].tools.map((t: any) => t.function.name).sort(), ["read", "safe_bash", "subagent", "subagent_message", "subagents_list"].sort());
  assert.ok(h.entries().some(e => e.type === "thinking_level_change" && e.thinkingLevel === "high"));
  await waitFor(() => h.calls().some(c => c[1] === "close"), h.diagnostic);
  assert.deepEqual(h.calls().filter(c => c[0] === "pane"), [["pane", "current", "--current"], ["pane", "close", "sim:current"]]);
});

test("terminal: role without exit flag stays interactive and prepends body only once", async () => {
  const h = start(role.replace("\nsystem-prompt: append", ""), "ROLE_MARKER", false, false, { task: "FIRST_CLI_TASK" });
  await waitFor(() => assistantMessages(h).length === 1, h.diagnostic);
  await delay(200); assert.equal(h.closed, false);
  h.keys("SECOND_CLI_TASK\r");
  await waitFor(() => assistantMessages(h).length === 2, h.diagnostic);
  assert.match(userTexts(requests[0]).join("\n"), /ROLE_MARKER[\s\S]*FIRST_CLI_TASK/);
  assert.equal(userTexts(requests[1]).at(-1), "SECOND_CLI_TASK");
  await h.stop();
});

test("terminal: role with no positional task accepts initial keyboard input without takeover", async () => {
  const h = start(role, "ROLE_MARKER", true, false, {});
  await waitFor(() => h.output.includes("role-model"), h.diagnostic);
  await delay(200); assert.equal(requests.length, 0);
  h.keys("FIRST_TYPED_TASK\r");
  await h.exited();
  assert.equal(requests.length, 1, h.diagnostic());
  assert.match(userTexts(requests[0]).join("\n"), /FIRST_TYPED_TASK/);
});

test("terminal: invalid roles report errors and exit without any extra input", async () => {
  const cases: Array<[string | null, string | undefined, RegExp]> = [
    [role, "unknown-role", /Unknown agent role/],
    ["model: missing/model", undefined, /Model unavailable/],
    ["thinking: turbo", undefined, /Invalid thinking/],
    ["cli: claude", undefined, /only support pi/],
    [null, undefined, /requires --subagent-agent/],
  ];
  for (const [fields, agent, error] of cases) {
    const h = start(fields, "MUST_NOT_RUN", true, true, { agent, task: "MUST_NOT_RUN" });
    await h.exited();
    assert.equal(requests.length, 0, h.diagnostic());
    assert.deepEqual(h.calls(), []);
    assert.match(h.output, error);
  }
});

test("terminal: typing takes over the session and survives /reload", async () => {
  const h = start(role, "ROLE_MARKER", true, true, { task: "SLOW_TASK" });
  replies = [{ delay: 500 }];
  await waitFor(() => requests.length === 1, h.diagnostic);
  h.keys("HUMAN_DRAFT");
  await waitFor(() => assistantMessages(h).length === 1, h.diagnostic);
  await delay(200); assert.equal(h.closed, false, h.diagnostic());
  h.keys("\x03/reload\r");
  await waitFor(() => h.output.includes("Reloaded keybindings"), h.diagnostic);
  h.keys("AFTER_RELOAD_TASK\r");
  await waitFor(() => assistantMessages(h).length === 2, h.diagnostic);
  await delay(200); assert.equal(h.closed, false, h.diagnostic());
  assert.match(userTexts(requests[1]).join("\n"), /AFTER_RELOAD_TASK/);
  assert.ok(!h.calls().some(c => c[1] === "close"));
  await h.stop();
});

test("terminal: Escape abort retains the session after the next completed task", async () => {
  const h = start(role, "ROLE_MARKER", true, false, { task: "ABORT_TASK" });
  replies = [{ delay: 1000 }];
  await waitFor(() => requests.length === 1, h.diagnostic);
  h.keys("\x1b");
  await waitFor(() => assistantMessages(h).some(m => m.stopReason === "aborted"), h.diagnostic);
  await delay(200); assert.equal(h.closed, false);
  h.keys("\x03AFTER_ESCAPE_TASK\r");
  await waitFor(() => assistantMessages(h).some(m => m.stopReason === "stop"), h.diagnostic);
  await delay(200); assert.equal(h.closed, false, h.diagnostic());
  await h.stop();
});

test("terminal: provider error leaves pane open for a human follow-up", async () => {
  const h = start(role, "ROLE_MARKER", true, true, { task: "FAIL_TASK" });
  replies = [{ error: true }];
  await waitFor(() => assistantMessages(h).some(m => m.stopReason === "error"), h.diagnostic);
  await delay(200); assert.equal(h.closed, false, h.diagnostic());
  assert.match(h.output, /SIMULATED_PROVIDER_ERROR/);
  h.keys("RETRY_TASK\r");
  await waitFor(() => assistantMessages(h).some(m => m.stopReason === "stop"), h.diagnostic);
  await delay(200); assert.equal(h.closed, false, h.diagnostic());
  assert.ok(!h.calls().some(c => c[1] === "close"));
  await h.stop();
});
