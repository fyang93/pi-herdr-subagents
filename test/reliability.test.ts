import "./isolate.ts";
import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import extension, { __test__ as state } from "../pi-extension/subagents/index.ts";
import { ensurePiIntegration, interpretExitSidecar } from "../pi-extension/subagents/herdr.ts";
import {
  nameRegistryPath, pendingInboxMessages, pendingQuestions, publishQuestion,
  readNameRegistry, readSubagentLoadout, registerName, writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "subagent-reliability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fault injection works under root too; permissions alone would not reproduce failures there.
function mockFs(t: TestContext, method: "rmSync" | "readFileSync" | "writeFileSync" | "renameSync", implementation: (...args: any[]) => any) {
  const mocked = t.mock.method(fs, method, implementation);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

const loadout: SubagentLoadout = {
  agent: "worker", toolAllowlist: "read,ask_question", systemPromptMode: "append",
  identity: "Keep this identity", spawnable: null, cwd: null, agentDir: null,
};

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition did not settle");
    await delay(10);
  }
}

async function parent(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), "subagent-messaging-"));
  const savedEnv = { ...process.env }, savedDeps = { ...state.launchDeps };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
  const handlers = new Map<string, (...args: any[]) => any>(), tools = new Map<string, any>();
  const sent: any[] = [];
  extension({
    on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {}, registerMessageRenderer() {},
    sendMessage(message: any) { sent.push(message); },
  } as any);
  const ctx = {
    cwd: dir, hasUI: false, isIdle: () => true, ui: { notify() {} },
    sessionManager: { getSessionDir: () => dir, getSessionId: () => "parent" },
  };
  const finish = new Map<string, () => void>();
  const shutdown = () => handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  t.after(async () => {
    // A test may invoke the real watcher and untrack a child owned by the stub watcher.
    for (const done of finish.values()) done();
    try { await shutdown(); }
    finally {
      Object.assign(state.launchDeps, savedDeps);
      process.env = savedEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  await ensurePiIntegration();
  state.launchDeps.watchSubagent = (child, signal) => new Promise(resolve => {
    const done = () => {
      signal.removeEventListener("abort", done);
      state.runningSubagents.delete(child.id);
      finish.delete(child.id);
      resolve({ summary: "Done", exitCode: 0, elapsed: 0 });
    };
    finish.set(child.id, done);
    signal.addEventListener("abort", done, { once: true });
  });
  let starts = 0;
  state.launchDeps.findSessionAgent = async () => null;
  state.launchDeps.startAgent = async () => ({ surface: `w1:p${++starts + 2}`, agent: "resumed" });
  function live(name: string) {
    const sessionFile = join(dir, `${name}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: name, version: 3, cwd: dir }) + "\n");
    writeSubagentLoadout(sessionFile, { ...loadout, cwd: dir, agentDir: dir });
    registerName(join(dir, "artifacts", "parent"), name, { sessionFile });
    const child = { id: name, name, task: "original", surface: "w1:p2", herdrName: name,
      sessionFile, startTime: Date.now(), interactive: false };
    state.runningSubagents.set(name, child);
    state.watchAndDeliver(child);
    return child;
  }
  function message(name: string, text: string, signal?: AbortSignal): Promise<any> {
    const pending = tools.get("subagent_message").execute("call", { name, message: text }, signal, undefined, ctx);
    void pending.catch(() => {}); // cleanup may abort an outstanding call after a failed assertion
    return pending;
  }
  return { dir, live, message, finish, sent, shutdown, get starts() { return starts; } };
}

function consume(session: string): string[] {
  return pendingInboxMessages(session).map(file => {
    const { message } = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file);
    return message;
  });
}

it("serializes concurrent messages through exit and resume, without mistaking cleanup for receipt", async t => {
  const h = await parent(t), child = h.live("worker");
  const a = h.message(child.name, "A"), b = h.message(child.name, "B");
  assert.equal(pendingInboxMessages(child.sessionFile).length, 1, "B waits before publishing");
  h.finish.get(child.id)!(); // the old child read neither message
  assert.equal((await a).details.status, "started");
  await waitFor(() => pendingInboxMessages(child.sessionFile).length === 2);
  assert.deepEqual(consume(child.sessionFile), ["A", "B"], "resume retained both messages in order");
  assert.equal((await b).details.status, "steered");
  assert.equal(h.starts, 1);
});

it("cancels a queued sender promptly without letting its successor overtake, or blocking another child", async t => {
  const h = await parent(t), child = h.live("worker"), other = h.live("other");
  const a = h.message(child.name, "A");
  const cancel = new AbortController();
  const b = h.message(child.name, "B", cancel.signal);
  cancel.abort();
  await assert.rejects(b, /abort/i);
  const c = h.message(child.name, "C");
  const independent = h.message(other.name, "OTHER");
  assert.deepEqual(consume(other.sessionFile), ["OTHER"]);
  assert.equal((await independent).details.status, "steered");
  assert.deepEqual(consume(child.sessionFile), ["A"], "C cannot overtake A after cancelling B");
  assert.equal((await a).details.status, "steered");
  await waitFor(() => pendingInboxMessages(child.sessionFile).length === 1);
  assert.deepEqual(consume(child.sessionFile), ["C"]);
  assert.equal((await c).details.status, "steered");
  assert.equal(h.starts, 0);
});

it("shutdown cancels active and queued message calls without publishing the queued message", async t => {
  const h = await parent(t), child = h.live("worker");
  const a = h.message(child.name, "A"), b = h.message(child.name, "B");
  await h.shutdown();
  await assert.rejects(a, /abort/i);
  await assert.rejects(b, /abort/i);
  assert.deepEqual(consume(child.sessionFile), ["A"]);
});

it("a failed resume releases the message queue so the next message can retry", async t => {
  const h = await parent(t), child = h.live("worker");
  let starts = 0;
  state.launchDeps.startAgent = async () => {
    if (++starts === 1) throw new Error("simulated startup failure");
    return { surface: "w1:p3", agent: "resumed" };
  };
  const a = h.message(child.name, "A"), b = h.message(child.name, "B");
  h.finish.get(child.id)!();
  await assert.rejects(a, /simulated startup failure/);
  assert.equal((await b).details.status, "started");
  assert.deepEqual(consume(child.sessionFile), ["B"]);
  assert.equal(state.startingSessions.size, 0);
});

it("question cleanup errors neither close a working child nor repeat delivered questions, including after reload", async t => {
  const h = await parent(t), child = h.live("worker");
  publishQuestion(child.sessionFile, "FIRST?");
  const [file] = pendingQuestions(child.sessionFile).files;
  const remove = fs.rmSync;
  let failing = true;
  mockFs(t, "rmSync", (path, options) => {
    if (path === file && failing) throw Object.assign(new Error("simulated cleanup denial"), { code: "EACCES" });
    return remove(path, options);
  });
  const warnings: string[] = [];
  t.mock.method(console, "warn", message => warnings.push(String(message)));
  const closed: string[] = [];
  await state.watchSubagent(child, new AbortController().signal, {
    wait: async (_name, _signal, options) => {
      options.onTick!("working");
      options.onTick!("working");
      publishQuestion(child.sessionFile, "SECOND?");
      options.onTick!("working");
      state.deliverPendingQuestion({ ...child }); // the plain running record is handed across reload
      assert.deepEqual(h.sent.map(m => m.details.question), ["FIRST?", "SECOND?"]);
      assert.equal(fs.existsSync(file), true);
      failing = false;
      options.onTick!("working");
      assert.deepEqual(pendingQuestions(child.sessionFile).files, []);
      return { reason: "interrupted", exitCode: 1 };
    },
    close: pane => { closed.push(pane); },
  });
  assert.deepEqual(closed, []);
  assert.equal(h.sent.length, 2);
  assert.equal(warnings.length, 1, "cleanup warns once, not on every poll");
  child.abortController?.abort();
});

it("unreadable questions are retained and do not stop supervision", async t => {
  const h = await parent(t), child = h.live("worker");
  publishQuestion(child.sessionFile, "DO NOT LOSE THIS");
  const [file] = pendingQuestions(child.sessionFile).files;
  const read = fs.readFileSync;
  mockFs(t, "readFileSync", (path, options) => {
    if (path === file) throw Object.assign(new Error("simulated read denial"), { code: "EACCES" });
    return read(path, options);
  });
  t.mock.method(console, "warn", () => {});
  await state.watchSubagent(child, new AbortController().signal, {
    wait: async (_name, _signal, options) => {
      options.onTick!("working");
      assert.equal(fs.existsSync(file), true);
      return { reason: "interrupted", exitCode: 1 };
    },
    close: () => assert.fail("a question read failure must not close the pane"),
  });
  assert.equal(h.sent.length, 0);
  child.abortController?.abort();
});

it("refuses to overwrite a damaged registry, including valid JSON with an invalid shape", t => {
  const dir = tempDir(t), file = nameRegistryPath(dir);
  for (const damaged of ['{"old":{"sessionFile":"/old.jsonl"},', "null", "[]", '{"old":{}}']) {
    fs.writeFileSync(file, damaged);
    assert.throws(() => readNameRegistry(dir), /Cannot read subagent registry/);
    assert.throws(() => registerName(dir, "new", { sessionFile: "/new.jsonl" }), /Cannot read subagent registry/);
    assert.equal(fs.readFileSync(file, "utf8"), damaged);
  }
});

it("does not treat a registry read error as an empty registry", t => {
  const dir = tempDir(t), file = nameRegistryPath(dir);
  registerName(dir, "old", { sessionFile: "/old.jsonl" });
  const read = fs.readFileSync, original = read(file, "utf8");
  mockFs(t, "readFileSync", (path, options) => {
    if (path === file) throw Object.assign(new Error("simulated read denial"), { code: "EACCES" });
    return read(path, options);
  });
  assert.throws(() => registerName(dir, "new", { sessionFile: "/new.jsonl" }), /simulated read denial/);
  assert.equal(read(file, "utf8"), original);
});

for (const failure of ["partial write", "rename"] as const) {
  it(`keeps the previous loadout after a failed ${failure}, and removes its temporary file`, t => {
    const dir = tempDir(t), session = join(dir, "child.jsonl");
    writeSubagentLoadout(session, loadout);
    const write = fs.writeFileSync;
    if (failure === "partial write") {
      mockFs(t, "writeFileSync", (file, content, options) => {
        if (String(file).endsWith(".tmp")) {
          write(file, "{", options);
          throw new Error("simulated disk full");
        }
        return write(file, content, options);
      });
    } else {
      mockFs(t, "renameSync", () => { throw new Error("simulated rename failure"); });
    }
    assert.throws(() => writeSubagentLoadout(session, { ...loadout, identity: "Changed" }), /simulated/);
    assert.deepEqual(readSubagentLoadout(session), loadout);
    assert.deepEqual(fs.readdirSync(dir), ["child.jsonl.loadout.json"]);
  });
}

it("expands model environment variables and rejects missing values", t => {
  const previous = process.env.AUDIT_MODEL;
  t.after(() => { if (previous === undefined) delete process.env.AUDIT_MODEL; else process.env.AUDIT_MODEL = previous; });
  process.env.AUDIT_MODEL = "provider/model";
  assert.equal(state.resolveModelEnv("${AUDIT_MODEL}"), "provider/model");
  assert.equal(state.resolveModelEnv("fixed/model"), "fixed/model");
  delete process.env.AUDIT_MODEL;
  assert.throws(() => state.resolveModelEnv("${AUDIT_MODEL}"), /unset environment variable/);
  // The project's .env fills in, without entering the environment; the environment wins.
  const dir = fs.mkdtempSync(join(tmpdir(), "model-env-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, ".env"), "AUDIT_MODEL=dotenv/model\n");
  assert.equal(state.resolveModelEnv("${AUDIT_MODEL}", dir), "dotenv/model");
  assert.equal(process.env.AUDIT_MODEL, undefined);
  process.env.AUDIT_MODEL = "provider/model";
  assert.equal(state.resolveModelEnv("${AUDIT_MODEL}", dir), "provider/model");
});

it("only accepts explicit, valid completion marker types", () => {
  for (const marker of [null, {}, [], "done", { type: "garbage" }, { type: ["done"] }]) {
    assert.equal(interpretExitSidecar(marker), undefined);
  }
  assert.deepEqual(interpretExitSidecar({ type: "done", summary: "answer" }), { reason: "done", exitCode: 0, summary: "answer" });
  assert.deepEqual(interpretExitSidecar({ type: "quit" }), { reason: "quit", exitCode: 1 });
  assert.match(interpretExitSidecar({ type: "error" })!.errorMessage!, /no errorMessage/);
});
