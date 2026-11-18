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
import coreStateExtension from "../pi-extension/subagents/herdr-core-state.ts";
import { __test__ as watcher } from "../pi-extension/subagents/index.ts";

const dir = mkdtempSync(join(tmpdir(), "core-test-"));
const path = process.platform === "win32" ? `\\\\.\\pipe\\pi-core-test-${randomUUID()}` : join(dir, "core.sock");
const calls: { method: string; params: any }[] = [];
const sockets = new Set<Socket>();
const terminals = new Map<string, any>();
let next = 1;
let slowRun: (() => void) | undefined;
let templates: { name: unknown }[] = [];
let templateError: string | undefined;
let runError: string | undefined;
const noResponse = new Set<string>();
let afterRead: (() => void) | undefined;
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
      if (noResponse.has(`${method}:${params.terminal}`)) { socket.destroy(); continue; }
      if (method === "templates.list") {
        if (templateError) error(templateError);
        else send({ templates });
      }
      else if (method === "terminal.run") {
        if (runError) { error(runError); continue; }
        const address = `t${next++}`;
        const made = { address, state: "live", argv: params.argv, labels: params.labels, status: { state: "working" } };
        terminals.set(address, made);
        if (slowRun) { const fn = slowRun; slowRun = () => { send(made); fn(); }; }
        else send(made);
      } else if (method === "terminal.list") send({ terminals: [...terminals.values()].filter(t => t.labels?.["pi.subagent.managed"] === "1") });
      else if (method === "test.hang") { /* wait for timeout/abort */ }
      else if (method === "test.malformed") socket.write("bad json\n");
      else if (!terminal) error("not_found");
      else if (method === "terminal.get") send(terminal);
      else if (method === "terminal.kill") { terminal.state = "finished"; send(terminal); }
      else if (method === "terminal.rm") {
        if (terminal.state !== "finished") error("live");
        else { terminals.delete(params.terminal); send({ removed: params.terminal }); }
      }
      else if (method === "terminal.label") {
        terminal.labels ??= {};
        for (const [key, value] of Object.entries(params.labels)) {
          if (value === "") delete terminal.labels[key];
          else terminal.labels[key] = value;
        }
        send(terminal);
      }
      else if (method === "terminal.read") { send({ text: "测试 output\n" }); afterRead?.(); }
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
  it("refuses case-insensitive pi/claude template collisions before creating any terminal", async () => {
    const before = calls.filter(c => c.method === "terminal.run").length;
    try {
      for (const [kind, name] of [["pi", "Pi"], ["claude", "CLAUDE"]] as const) {
        templates = [{ name }];
        await assert.rejects(backend.startAgent({ ...launch, kind, args: ["--session-id", "claude-session"] }), /template conflict.*Rename or remove/);
      }
      assert.equal(calls.filter(c => c.method === "terminal.run").length, before);
    } finally { templates = []; }
  });
  it("fails closed with an update hint and preserves the templates.list RPC cause", async () => {
    templateError = "method_not_found";
    const before = calls.filter(c => c.method === "terminal.run").length;
    try {
      await assert.rejects(backend.startAgent(launch), (error: any) => {
        assert.match(error.message, /Cannot safely verify.*templates\.list.*Update herdr-core/);
        assert.ok(error.cause instanceof CoreError);
        assert.equal(error.cause.code, "method_not_found");
        return true;
      });
    } finally { templateError = undefined; }
    assert.equal(calls.filter(c => c.method === "terminal.run").length, before);
  });
  it("fails closed if templates cannot be listed", async () => {
    noResponse.add("templates.list:undefined");
    const before = calls.filter(c => c.method === "terminal.run").length;
    try {
      await assert.rejects(backend.startAgent(launch), (error: any) => {
        assert.match(error.message, /Cannot safely verify.*Update herdr-core/);
        assert.match(error.cause.message, /closed/);
        return true;
      });
    } finally { noResponse.clear(); }
    assert.equal(calls.filter(c => c.method === "terminal.run").length, before);
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
  it("preserves native unknown/error/blocked status without mutating keep", async () => {
    const record = terminals.get("t2");
    record.keep = true;
    const before = calls.length;
    for (const state of ["unknown", "error", "blocked", "future-state"]) {
      record.status.state = state;
      assert.equal((await backend.agentStatus("t2") as any).status, state === "future-state" ? "unknown" : state);
    }
    assert.deepEqual(calls.slice(before).map(c => c.method), Array(4).fill("terminal.get"));
    assert.equal(record.keep, true);
  });
  it("detects both loss phases only for managed records, excluding replacements from recovery", async () => {
    for (const changes of [{ reason: "signaled", argv: ["pi"] }, { reason: "holder_lost", argv: ["claude"] }, { reason: "stopped_by_restart", argv: ["pi"] }, { reason: "server_stop", argv: ["claude"] }, { reason: "host_shutdown", argv: ["pi"] }, { reason: null, argv: ["/bin/sh"] }]) {
      terminals.set("lost", { address: "lost", state: "live", keep: true, labels: { "pi.subagent.managed": "1", "pi.subagent.session": "lost-session" }, ...changes });
      const before = calls.length;
      assert.equal(await backend.agentStatus("lost"), "exited");
      assert.equal(await backend.findSessionAgent("lost-session"), null);
      await backend.closeSurface("lost", "lost-session");
      assert.deepEqual(calls.slice(before).map(c => c.method), ["terminal.get", "terminal.list", "terminal.get"]);
      assert.equal(terminals.get("lost").keep, true);
    }
    terminals.delete("lost");
    for (const record of [{ labels: {}, argv: ["/bin/sh"], reason: "signaled" }, { labels: { "pi.subagent.managed": "1" } }]) {
      terminals.set("uncertain", { address: "uncertain", state: "live", ...record });
      assert.notEqual(await backend.agentStatus("uncertain"), "exited");
      const before = calls.length;
      await backend.closeSurface("uncertain");
      assert.deepEqual(calls.slice(before).map(c => c.method), ["terminal.get"]);
    }
    terminals.delete("uncertain");
  });
  it("protects replacement shells on marker completion, markerless interruption, cancellation and late cleanup races", async () => {
    const id = "replacement";
    const make = (argv = ["/bin/sh"]) => terminals.set(id, { address: id, state: "live", argv, keep: true, labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(session) } });
    const running = () => ({ id, name: id, herdrName: id, surface: id, sessionFile: session, startTime: Date.now() }) as any;
    for (const marker of [false, true]) {
      make();
      if (marker) writeFileSync(session + ".exit", JSON.stringify({ type: "done", summary: "original result" }));
      else rmSync(session + ".exit", { force: true });
      const before = calls.length;
      const result = await watcher.watchSubagent(running(), new AbortController().signal, {
        wait: (agent, signal, options) => backend.waitForExit(agent, signal, { ...options, interval: 1 }),
      });
      assert.equal(result.exitCode, marker ? 0 : 1);
      assert.match(result.summary, marker ? /original result/ : /interrupted/);
      assert.equal(calls.slice(before).some(c => ["terminal.keep", "terminal.kill", "terminal.rm"].includes(c.method)), false);
      assert.equal(terminals.get(id).keep, true);
    }
    const before = calls.length;
    await watcher.watchSubagent(running(), AbortSignal.abort());
    assert.equal(calls.slice(before).some(c => ["terminal.keep", "terminal.kill", "terminal.rm"].includes(c.method)), false);
    // The session may change after waitForExit checked it, but before cleanup.
    make(["pi"]);
    await watcher.watchSubagent(running(), new AbortController().signal, {
      wait: async () => {
        terminals.get(id).labels["pi.subagent.session"] = "new-session";
        return { reason: "done", exitCode: 0 };
      },
    });
    assert.equal(terminals.has(id), true);
    // Late recovery after cancellation's status read is also guarded at close.
    make(["pi"]);
    await watcher.watchSubagent(running(), AbortSignal.abort(), {
      status: async () => { terminals.get(id).argv = ["/bin/sh"]; return "exited"; },
    });
    assert.equal(terminals.has(id), true);
    terminals.delete(id);
  });
  it("still cleans up original live Pi for normal completion/cancel and only rms finished owned records", async () => {
    const id = "original";
    const running = { id, name: id, herdrName: id, surface: id, sessionFile: session, startTime: Date.now() } as any;
    for (const mode of ["done", "cancel", "finished"]) {
      terminals.set(id, { address: id, state: mode === "finished" ? "finished" : "live", argv: [mode === "cancel" ? "claude" : "pi"], labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(session) } });
      const before = calls.length;
      await watcher.watchSubagent(running, mode === "cancel" ? AbortSignal.abort() : new AbortController().signal, {
        ...(mode === "cancel" ? {} : { wait: async () => ({ reason: "done" as const, exitCode: 0 }) }),
      });
      assert.equal(terminals.has(id), false);
      assert.equal(calls.slice(before).some(c => c.method === "terminal.kill"), mode !== "finished");
      assert.equal(calls.slice(before).some(c => c.method === "terminal.rm"), true);
    }
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
  it("allows non-conflicting names and ignores malformed template names safely", async () => {
    templates = [{ name: "reviewer" }, { name: null }, { name: 42 }];
    try {
      const child = await backend.startAgent(launch);
      await backend.closePane(child.surface);
      assert.equal(calls.findLast(c => c.method === "terminal.run")!.params.argv[0], "pi");
    } finally { templates = []; }
  });
  it("rejects stale identity before creating a terminal", async () => {
    process.env.HC_TERMINAL_ID = "missing";
    const count = calls.filter(c => c.method === "terminal.run").length;
    await assert.rejects(backend.startAgent(launch), CoreError);
    assert.equal(calls.filter(c => c.method === "terminal.run").length, count);
    process.env.HC_TERMINAL_ID = "parent";
  });
  it("allows unrelated templates and surfaces spawn_failed as an RPC error", async () => {
    templates = [{ name: "reviewer" }];
    try {
      for (const kind of ["pi", "claude"] as const) {
        const child = await backend.startAgent({ ...launch, kind, ...(kind === "claude" ? { args: ["--session-id", "claude-session"] } : {}) });
        assert.equal(calls.findLast(c => c.method === "terminal.run")!.params.argv[0], kind);
        await backend.closePane(child.surface);
      }
      runError = "spawn_failed";
      await assert.rejects(backend.startAgent(launch), (error: any) => error instanceof CoreError && error.code === "spawn_failed");
    } finally { templates = []; runError = undefined; }
  });
  it("updates session labels on session_start, removes an empty session, preserving other labels", async () => {
    let onStart: any;
    coreStateExtension({ on(event: string, handler: any) { assert.equal(event, "session_start"); onStart = handler; } } as any);
    const parent = terminals.get("parent");
    parent.labels = { "pi.subagent.managed": "1", "pi.subagent.name": "parent", "herdr.space": "space", "pi.subagent.session": "old" };
    let current: string | undefined = "relative/new.jsonl";
    const ctx = { sessionManager: { getSessionFile: () => current } };
    await onStart({}, ctx);
    assert.equal(parent.labels["pi.subagent.session"], resolve(current));
    current = "relative/resumed.jsonl";
    await onStart({}, ctx);
    assert.equal(parent.labels["pi.subagent.session"], resolve(current));
    current = "relative/fork.jsonl";
    await onStart({}, ctx);
    assert.equal(parent.labels["pi.subagent.session"], resolve(current));
    current = undefined;
    await onStart({}, ctx);
    assert.deepEqual(parent.labels, { "pi.subagent.managed": "1", "pi.subagent.name": "parent", "herdr.space": "space" });
  });
  it("diagnoses and removes an owned finished core child after interruption, without killing it", async () => {
    const id = "crashed";
    terminals.set(id, { address: id, state: "finished", exit_code: 137, reason: "signaled", labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(session) } });
    const before = calls.length;
    const result = await watcher.watchSubagent({ id, name: id, herdrName: id, surface: id, sessionFile: session, startTime: Date.now() } as any, new AbortController().signal, {
      wait: async () => ({ reason: "interrupted", exitCode: 1, errorMessage: "No completion marker." }),
      close: () => assert.fail("interrupted watcher must not call generic close"),
    });
    assert.match(result.summary, /exit_code=137, reason=signaled/);
    assert.match(result.summary, /测试 output/);
    assert.match(result.errorMessage!, /测试 output/);
    assert.equal(terminals.has(id), false);
    assert.equal(calls.slice(before).some(c => c.method === "terminal.kill"), false);
    assert.deepEqual(calls.slice(before).map(c => c.method), ["terminal.get", "terminal.read", "terminal.get", "terminal.rm"]);
  });
  it("never cleans up live, unknown-owned, session-mismatched or preservePane interruptions", async () => {
    for (const overrides of [
      { state: "live" },
      { labels: {} },
      { labels: { "pi.subagent.managed": "1" } },
      { labels: { "pi.subagent.session": resolve(session) } },
      { labels: { "pi.subagent.managed": "1", "pi.subagent.session": "another-session" } },
      { preservePane: true },
    ]) {
      const id = "preserved";
      const { preservePane, ...record } = overrides;
      terminals.set(id, { address: id, state: "finished", labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(session) }, ...record });
      const before = calls.length;
      const result = await watcher.watchSubagent({ id, name: id, herdrName: id, surface: id, sessionFile: session, startTime: Date.now() } as any, new AbortController().signal, {
        wait: async () => ({ reason: "interrupted", exitCode: 1, preservePane }),
        close: () => assert.fail("must not close"),
      });
      assert.equal(result.exitCode, 1);
      assert.equal(terminals.has(id), true);
      assert.equal(calls.slice(before).some(c => ["terminal.read", "terminal.kill", "terminal.rm"].includes(c.method)), false);
      if (preservePane) assert.equal(calls.length, before);
    }
  });
  it("rechecks ownership after reading output and tolerates missing records and no-response RPCs", async () => {
    const id = "racing";
    const make = () => terminals.set(id, { address: id, state: "finished", labels: { "pi.subagent.managed": "1", "pi.subagent.session": resolve(session) } });
    const watch = () => watcher.watchSubagent({ id, name: id, herdrName: id, surface: id, sessionFile: session, startTime: Date.now() } as any, new AbortController().signal, {
      wait: async () => ({ reason: "interrupted", exitCode: 1 }), close: () => assert.fail("must not close"),
    });
    make();
    afterRead = () => { terminals.get(id).labels["pi.subagent.session"] = "other"; };
    try { await watch(); } finally { afterRead = undefined; }
    assert.equal(terminals.has(id), true);
    terminals.delete(id);
    assert.match((await watch()).summary, /not_found/);
    make(); noResponse.add(`terminal.get:${id}`);
    try { assert.match((await watch()).summary, /Could not inspect.*closed/); }
    finally { noResponse.clear(); }
    assert.equal(terminals.has(id), true);
    noResponse.add(`terminal.read:${id}`);
    try { assert.match((await watch()).summary, /Could not read terminal output/); }
    finally { noResponse.clear(); }
    assert.equal(terminals.has(id), false);
    make(); noResponse.add(`terminal.rm:${id}`);
    try { assert.match((await watch()).summary, /Could not remove finished terminal/); }
    finally { noResponse.clear(); }
    assert.equal(terminals.has(id), true);
  });
  it("leaves legacy interrupted panes open without contacting core", async () => {
    const socket = process.env.HC_TERMINAL_SOCKET;
    delete process.env.HC_TERMINAL_SOCKET;
    const before = calls.length;
    try {
      const result = await watcher.watchSubagent({ id: "legacy", name: "legacy", herdrName: "legacy", surface: "w1:p2", sessionFile: session, startTime: Date.now() } as any, new AbortController().signal, {
        wait: async () => ({ reason: "interrupted", exitCode: 1 }), close: () => assert.fail("legacy pane must stay open"),
      });
      assert.match(result.summary, /Subagent interrupted/);
      assert.equal(calls.length, before);
    } finally { process.env.HC_TERMINAL_SOCKET = socket; }
  });
  it("handles errors, malformed responses, timeouts and aborts", async () => {
    assert.equal(await backend.agentStatus("missing"), "exited");
    await assert.rejects(coreRequest("test.malformed", {}), SyntaxError);
    await assert.rejects(coreRequest("test.hang", {}, { timeout: 10 }), /timed out/);
    await assert.rejects(coreRequest("test.hang", {}, { signal: AbortSignal.abort() }));
  });
});
