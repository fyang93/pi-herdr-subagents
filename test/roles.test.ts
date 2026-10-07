import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";
import done from "../pi-extension/subagents/subagent-done.ts";
import { registerName, writeSubagentLoadout } from "../pi-extension/subagents/session.ts";

function harness(flags: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const entries: any[] = [];
  let active = ["read", "write", "bash", "subagent", "subagent_message", "subagents_list"];
  let model: unknown, thinking: unknown, keys: ((data: string) => void) | undefined;
  let idle = true, pending = false, draft = "", shutdowns = 0, stopped = false;
  const api: any = {
    on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    registerFlag() {}, getFlag: (name: string) => flags[name],
    registerTool(tool: any) { tools.push(tool); active.push(tool.name); },
    registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
    getAllTools: () => tools,
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    setModel: async (value: unknown) => { model = value; return true; },
    setThinkingLevel: (value: unknown) => { thinking = value; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const ctx: any = {
    cwd: process.cwd(), hasUI: true,
    modelRegistry: { getAll: () => [{ provider: "test", id: "model" }] },
    sessionManager: { getSessionFile: () => "/test/session.jsonl", getSessionId: () => "session", getSessionDir: () => process.cwd(), getEntries: () => entries },
    isIdle: () => idle, hasPendingMessages: () => pending,
    shutdown() { shutdowns++; }, abort() { stopped = true; },
    ui: { notify() {}, getEditorText: () => draft,
      onTerminalInput(fn: (data: string) => void) { keys = fn; return () => { keys = undefined; }; } },
  };
  return {
    api, ctx, tools, entries,
    async emit(name: string, event: any = {}) {
      const results = [];
      for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
      return results;
    },
    key(data: string) { keys?.(data); },
    busy(value: boolean) { idle = !value; }, pending(value: boolean) { pending = value; }, draft(value: string) { draft = value; },
    get active() { return active; }, get model() { return model; }, get thinking() { return thinking; },
    get shutdowns() { return shutdowns; }, get stopped() { return stopped; },
  };
}

async function isolated(fn: (project: string, global: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-role-"));
  const cwd = process.cwd(), env = { ...process.env };
  const project = join(dir, "project"), global = join(dir, "global");
  mkdirSync(join(project, ".pi/agents"), { recursive: true });
  mkdirSync(join(global, "agents"), { recursive: true });
  process.chdir(project);
  process.env.PI_CODING_AGENT_DIR = global;
  delete process.env.HERDR_ENV;
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
  try { await fn(project, global); }
  finally {
    process.chdir(cwd); process.env = env;
    const reset = harness(); extension(reset.api); await reset.emit("session_start");
    rmSync(dir, { recursive: true, force: true });
  }
}
const agent = (dir: string, file: string, fields: string, body = "Role instructions") =>
  writeFileSync(join(dir, file + ".md"), `---\n${fields}\n---\n${body}\n`);
const finished = { messages: [{ role: "assistant", stopReason: "stop" }] };

it("loads a top-level role by declared name with project priority, model, thinking, tools and delegation", async () => {
  await isolated(async (project, global) => {
    agent(join(global, "agents"), "host", "name: host\nmodel: invalid/global");
    const dir = join(project, ".pi/agents");
    agent(dir, "host-profile", "name: host\nmodel: test/model\nthinking: high\ntools: read, safe_bash\nsubagent_agents: scout, missing\nsystem-prompt: append");
    const h = harness({ "subagent-agent": "host" }); extension(h.api);
    await h.emit("session_start");
    assert.deepEqual(h.model, { provider: "test", id: "model" });
    assert.equal(h.thinking, "high");
    assert.deepEqual(h.active, ["read", "safe_bash", "subagent", "subagent_message", "subagents_list"]);
    assert.ok(h.tools.some(t => t.name === "safe_bash"));
    assert.ok(!h.tools.some(t => t.name === "ask_question"));
    assert.deepEqual((await h.emit("before_agent_start", { systemPrompt: "Base" }))[0], { systemPrompt: "Base\n\nRole instructions" });
    assert.deepEqual(h.entries, [{ type: "custom", customType: "subagent_role", data: { agent: "host" } }]);
    await h.emit("session_start", { reason: "reload" });
    assert.equal(h.entries.length, 1);
    const list = await h.tools.find(t => t.name === "subagents_list").execute();
    assert.deepEqual(list.details.agents.map((a: any) => a.name), ["scout"]);
    const spawn = h.tools.find(t => t.name === "subagent");
    assert.equal((await spawn.execute("c", { agent: "missing", task: "task" })).details.error, "agent not in allowlist");
    assert.equal((await spawn.execute("c", { agent: "worker", task: "task" })).details.error, "agent not in allowlist");
    assert.equal((await spawn.execute("c", { agent: "host", task: "task" })).details.error, "self-spawn blocked");
  });
});

it("denies delegation without subagent_agents even if tools explicitly name spawning tools; preserves the full ordinary toolset when tools is empty", async () => {
  await isolated(async (project) => {
    const dir = join(project, ".pi/agents");
    for (const tools of ["read,subagent,subagent_message,subagents_list", ""]) {
      agent(dir, "watcher", `thinking: low\ntools: ${tools}`);
      const h = harness({ "subagent-agent": "watcher" }); extension(h.api);
      await h.emit("session_start");
      assert.equal(h.thinking, "low");
      assert.ok(h.active.includes("read"));
      assert.ok(!h.active.includes("subagent"));
      if (!tools) assert.ok(h.active.includes("write"));
      assert.deepEqual(__test__.discoverAgentDefinitions(), []);
      const [input] = await h.emit("input", { text: "Task", source: "rpc" });
      assert.equal(input.text, "Role instructions\n\nTask");
      assert.equal((await h.emit("input", { text: "Next" }))[0], undefined);
    }
    agent(dir, "replace", "system-prompt: replace");
    const h = harness({ "subagent-agent": "replace" }); extension(h.api); await h.emit("session_start");
    assert.deepEqual((await h.emit("before_agent_start", { systemPrompt: "Base" }))[0], { systemPrompt: "Role instructions" });
    const args: string[] = [];
    __test__.applySandboxToArgs(args, { model: null, thinking: "high", toolAllowlist: "read" } as any, { name: "x", artifactDir: project });
    assert.deepEqual(args, ["--thinking", "high", "--tools", "read"]);
  });
});

it("applies a host-started role's own delegation allowlist just like a child, denying direct dispatch when omitted", async () => {
  await isolated(async (project) => {
    const moduleUrl = new URL("../pi-extension/subagents/index.ts", import.meta.url).href;
    for (const allowed of [undefined, "scout"]) {
      agent(join(project, ".pi/agents"), "host", allowed ? `subagent_agents: ${allowed}` : "tools: subagent");
      const h = harness({ "subagent-agent": "host" }); extension(h.api); await h.emit("session_start");
      const inspect = async (tools: any[]) => ({
        listed: (await tools.find(t => t.name === "subagents_list").execute()).details.agents.map((a: any) => a.name),
        errors: await Promise.all(["scout", "worker"].map(async name =>
          (await tools.find(t => t.name === "subagent").execute("c", { agent: name, task: "task" })).details.error)),
      });
      const result = await inspect(h.tools);
      assert.deepEqual(result, {
        listed: allowed ? ["scout"] : [],
        errors: [allowed ? "herdr not available" : "agent not in allowlist", "agent not in allowlist"],
      });
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import extension from ${JSON.stringify(moduleUrl)};
        const tools = []; extension({ on() {}, registerFlag() {}, registerTool(t) { tools.push(t); }, registerShortcut() {}, registerCommand() {}, registerMessageRenderer() {} });
        console.log(JSON.stringify(await (${inspect.toString()})(tools)));
      `], { env: { ...process.env, PI_SUBAGENT_AGENT: "host", PI_SUBAGENT_ALLOWED: allowed ?? "" }, encoding: "utf8" });
      assert.deepEqual(result, JSON.parse(output));
    }
  });
});

it("fails closed for unknown roles, unavailable models, invalid thinking, non-pi roles and --subagent-exit without a role", async () => {
  await isolated(async (project) => {
    const dir = join(project, ".pi/agents");
    for (const [name, fields] of [["bad-model", "model: unknown"], ["bad-thinking", "thinking: turbo"], ["claude", "cli: claude"]]) agent(dir, name, fields);
    for (const flags of [{ "subagent-exit": true }, ...["missing", "bad-model", "bad-thinking", "claude"].map(name => ({ "subagent-agent": name }))]) {
      const h = harness(flags); extension(h.api); await h.emit("session_start");
      assert.equal(h.shutdowns, 1);
      await h.emit("before_agent_start", { systemPrompt: "Base" });
      assert.equal(h.stopped, true);
      assert.equal(h.entries.length, 0);
      assert.deepEqual(h.active, []);
      assert.deepEqual((await h.emit("input", { text: "Do not run this task" }))[0], { action: "handled" });
    }
  });
});

it("resume cannot bypass a top-level role's delegation permissions", async () => {
  await isolated(async (project) => {
    const file = join(project, "child.jsonl");
    writeFileSync(file, '{"type":"session","id":"child"}\n');
    registerName(join(project, "artifacts/session"), "saved", { sessionFile: file, sessionId: "child" });
    writeSubagentLoadout(file, { agent: "scout", toolAllowlist: "read", model: null, thinking: null, identity: null, systemPromptMode: null, spawnable: null, autoExit: true, cwd: null, agentDir: null });
    process.env.HERDR_PANE_ID = "test:pane";
    agent(join(project, ".pi/agents"), "watcher", "tools: read");
    const restricted = harness({ "subagent-agent": "watcher" }); extension(restricted.api); await restricted.emit("session_start");
    process.env.HERDR_ENV = "1";
    const denied = await restricted.tools.find(t => t.name === "subagent_message").execute("c", { name: "saved", message: "continue" }, undefined, undefined, restricted.ctx);
    assert.match(denied.details.error, /spawning is not permitted/);
    delete process.env.HERDR_ENV;
  });
});

it("top-level auto-exit waits for idle, pending messages, child results and drafts; typing/Escape/abort/error retain the pane", async () => {
  const herdrEnv = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV; // This test must never close the runner's real pane.
  const childKey = Symbol.for("pi-subagents/running-children-count");
  const previous = (globalThis as any)[childKey];
  let children = 0;
  (globalThis as any)[childKey] = () => children;
  const start = async () => {
    const h = harness(); done(h.api, { topLevel: true, agent: () => "host", autoExit: () => true });
    await h.emit("session_start");
    // Initial externally submitted prompt is not a takeover; cursor/focus reports aren't either.
    h.key("Initial task");
    await h.emit("agent_start"); h.key("\x1b[12;34R"); h.key("\x1b[I");
    return h;
  };
  try {
    const h = await start(); h.busy(true);
    await h.emit("agent_end", finished); await delay(25); assert.equal(h.shutdowns, 0);
    h.busy(false); await h.emit("agent_before_settle", { outcome: "completed" });
    await h.emit("agent_settled"); assert.equal(h.shutdowns, 1, "settlement requests shutdown synchronously (including RPC)");
    await h.emit("session_shutdown", { reason: "quit" });
    for (const mode of ["pending", "children", "draft", "typing", "escape", "abort", "error"]) {
      const h = await start();
      if (mode === "pending") h.pending(true);
      if (mode === "children") children = 1;
      if (mode === "draft") h.draft("unfinished text");
      if (mode === "typing") h.key("\x1b[200~draft\x1b[201~");
      if (mode === "escape") h.key("\x1b");
      const event = mode === "abort" || mode === "error" ? { messages: [{ role: "assistant", stopReason: mode === "abort" ? "aborted" : "error", errorMessage: "provider unavailable" }] } : finished;
      await h.emit("agent_end", event); await delay(25); assert.equal(h.shutdowns, 0, mode);
      if (["typing", "escape", "abort"].includes(mode)) {
        await h.emit("input", { source: "extension" }); await h.emit("agent_start");
        await h.emit("agent_end", finished); await delay(25); assert.equal(h.shutdowns, 0, `${mode} stays taken over`);
      }
      children = 0;
      await h.emit("session_shutdown", { reason: "quit" });
    }
    const compacted = await start();
    await compacted.emit("agent_end", finished); await compacted.emit("session_before_compact");
    await delay(25); assert.equal(compacted.shutdowns, 0, "old pi must not exit during compaction");
    await compacted.emit("session_compact"); await delay(25); assert.equal(compacted.shutdowns, 1);
    await compacted.emit("session_shutdown", { reason: "quit" });
    const resumed = await start();
    children = 1; await resumed.emit("agent_end", finished); await resumed.emit("agent_settled");
    assert.equal(resumed.shutdowns, 0);
    children = 0; await resumed.emit("agent_start"); await resumed.emit("agent_end", finished);
    await resumed.emit("agent_settled"); assert.equal(resumed.shutdowns, 1, "exit after processing the last child result");
    await resumed.emit("session_shutdown", { reason: "quit" });
    const takenOver = await start(); takenOver.key("draft");
    await takenOver.emit("session_shutdown", { reason: "reload" });
    const reloaded = await start(); await reloaded.emit("agent_end", finished); await reloaded.emit("agent_settled");
    assert.equal(reloaded.shutdowns, 0, "human takeover survives reload");
    await reloaded.emit("session_shutdown", { reason: "quit" });
    const h2 = await start();
    await h2.emit("agent_end", finished);
    await h2.emit("session_shutdown", { reason: "reload" });
    await delay(25); assert.equal(h2.shutdowns, 0, "reload cancels the old timer");
  } finally {
    (globalThis as any)[childKey] = previous;
    if (herdrEnv === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = herdrEnv;
  }
});
