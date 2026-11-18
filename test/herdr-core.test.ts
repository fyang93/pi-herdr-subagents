import "./isolate.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as backend from "../pi-extension/subagents/herdr.ts";
import { coreRequest, CoreError } from "../pi-extension/subagents/herdr-core.ts";

const dir = mkdtempSync(join(tmpdir(), "core-test-"));
const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-core-test-${randomUUID()}` : join(dir, "core.sock");
const calls: { method: string; params: any }[] = [];
const sockets = new Set<Socket>();
const terminals = new Map<string, any>();
let next = 1;
let slowRun: (() => void) | undefined;
const server = createServer((socket) => {
  sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const { method, params } = message; calls.push({ method, params });
      const send = (result: unknown) => socket.write(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }) + "\n");
      const error = (kind: string) => socket.write(JSON.stringify({ id: message.id, error: { code: -32000, message: kind, data: { kind } } }) + "\n");
      const terminal = terminals.get(params.terminal);
      if (method === "terminal.run") {
        const address = `t${next++}`;
        const made = { address, state: "live", labels: params.labels, status: { state: "working" } };
        terminals.set(address, made);
        if (slowRun) { const fn = slowRun; slowRun = () => { send(made); fn(); }; }
        else send(made);
      } else if (method === "terminal.list") send({ terminals: [...terminals.values()].filter(t => t.labels?.["pi.subagent.managed"] === "1") });
      else if (method === "test.hang") { /* wait for timeout/abort */ }
      else if (method === "test.malformed") socket.write("bad json\n");
      else if (!terminal) error("not_found");
      else if (method === "terminal.get") send(terminal);
      else if (method === "terminal.kill") { terminal.state = "finished"; send(terminal); }
      else if (method === "terminal.rm") { terminals.delete(params.terminal); send({ removed: true }); }
      else if (method === "terminal.read") send({ text: "测试 output\n" });
      else if (method === "terminal.send") send({ turn: 1 });
      else error("unknown_method");
    }
  });
});

before(async () => {
  server.listen(path); await once(server, "listening");
  process.env.HC_TERMINAL_SOCKET = path;
  process.env.HC_TERMINAL_ID = "parent";
  terminals.set("parent", { address: "parent", state: "live", labels: {} });
});
after(async () => {
  delete process.env.HC_TERMINAL_SOCKET; delete process.env.HC_TERMINAL_ID;
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
});
const session = join(dir, "child.jsonl");
const launch = { name: "测试 worker", kind: "pi" as const, args: ["--session", session, "--append-system-prompt", "C:\\a b\\身份.md"], cwd: dir, env: { PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ALLOWED: "scout, researcher" } };

describe("herdr-core backend", () => {
  it("recognizes core and prioritizes it over inherited legacy variables", async () => {
    process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "w1:p1";
    assert.equal(backend.isHerdrAvailable(), true);
    assert.equal(backend.isCoreAvailable(), true);
    assert.equal(await backend.ensurePiIntegration(), false);
  });
  it("starts parallel isolated terminals preserving argv, env, session and parent", async () => {
    const results = await Promise.all([backend.startAgent(launch), backend.startAgent(launch)]);
    assert.notEqual(results[0].surface, results[1].surface);
    assert.equal(results[0].surface, results[0].agent);
    const run = calls.find(c => c.method === "terminal.run")!.params;
    assert.deepEqual(run.argv, ["pi", ...launch.args]);
    assert.deepEqual(run.env, launch.env);
    assert.equal(run.parent, "parent"); assert.equal(run.no_notify, true); assert.equal(run.keep, false);
    assert.equal(run.labels["pi.subagent.session"], resolve(session));
    assert.equal(run.labels["pi.subagent.name"], launch.name);
  });
  it("maps status, reads output, sends text and recovers live sessions by immutable ID", async () => {
    assert.deepEqual(await backend.agentStatus("t1"), { status: "working", pane: "t1", session: resolve(session) });
    assert.deepEqual(await backend.findSessionAgent(resolve(session)), { agent: "t1", pane: "t1" });
    assert.equal(await backend.readScreen("t1"), "测试 output");
    await backend.promptAgent("t1", "a\n多行");
    assert.equal(calls.at(-1)!.params.text, "a\n多行");
    terminals.get("t1").status.state = "blocked";
    assert.equal((await backend.agentStatus("t1") as any).status, "blocked");
  });
  it("collects a sidecar result and removes only the child terminal", async () => {
    writeFileSync(session + ".exit", JSON.stringify({ type: "done", summary: "CORE_OK" }));
    terminals.get("t1").state = "finished";
    const result = await backend.waitForExit("t1", new AbortController().signal, { interval: 5, sessionFile: session });
    assert.equal(result.summary, "CORE_OK");
    await backend.closePane("t1"); await backend.closePane("t1");
    assert.equal(terminals.has("t1"), false); assert.equal(terminals.has("parent"), true);
  });
  it("lets creation answer before honoring cancellation, then cleans up", async () => {
    const controller = new AbortController();
    let released = false;
    slowRun = () => { released = true; };
    const started = backend.startAgent(launch, controller.signal);
    while (!calls.some(c => c.method === "terminal.run" && terminals.has("t3"))) await new Promise(r => setTimeout(r, 5));
    controller.abort(); slowRun!(); slowRun = undefined;
    await assert.rejects(started);
    assert.equal(released, true); assert.equal(terminals.has("t3"), false);
  });
  it("rejects stale identity before creating a terminal", async () => {
    process.env.HC_TERMINAL_ID = "missing";
    const count = calls.filter(c => c.method === "terminal.run").length;
    await assert.rejects(backend.startAgent(launch), CoreError);
    assert.equal(calls.filter(c => c.method === "terminal.run").length, count);
    process.env.HC_TERMINAL_ID = "parent";
  });
  it("handles errors, malformed responses, timeouts and aborts", async () => {
    assert.equal(await backend.agentStatus("missing"), "exited");
    await assert.rejects(coreRequest("test.malformed", {}), SyntaxError);
    await assert.rejects(coreRequest("test.hang", {}, { timeout: 10 }), /timed out/);
    await assert.rejects(coreRequest("test.hang", {}, { signal: AbortSignal.abort() }));
  });
});
