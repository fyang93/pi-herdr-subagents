import "./isolate.ts";
import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { presentCoreTerminal, parentAppSpace, type AppSnapshot } from "../pi-extension/subagents/herdr-app.ts";

before(() => { delete process.env.PI_SUBAGENT_APP_LAYOUT; });
after(() => { process.env.PI_SUBAGENT_APP_LAYOUT = "hidden"; });
const snapshot = (): AppSnapshot => ({ spaces: [
  { id: "other", tabs: [{ id: "focused-tab", terminals: [{ terminal: "unrelated" }] }] },
  { id: "parent-space", tabs: [{ id: "parent-tab", terminals: [{ terminal: "parent" }] }] },
] });
function fixture() {
  const state = snapshot();
  const calls: { method: string; params: any }[] = [];
  const commands: string[][] = [];
  const core = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "terminal.get") return { labels: { "herdr.space": "parent-space" } };
    if (method === "terminal.label") state.spaces[1].tabs.push({ id: params.labels["herdr.tab"], terminals: [{ terminal: params.terminal }] });
    return {};
  };
  const app = async (args: string[]) => { commands.push(args); return args[0] === "ls" ? structuredClone(state) : {}; };
  return { state, calls, commands, core, app };
}

it("finds the parent's space, not the focused space, and excludes remote terminals", () => {
  assert.equal(parentAppSpace(snapshot(), "parent"), "parent-space");
  assert.equal(parentAppSpace(snapshot(), "missing"), undefined);
  const remote = snapshot(); remote.spaces[1].machine = "remote";
  assert.equal(parentAppSpace(remote, "parent"), undefined);
});
it("gives parallel children separate named background tabs, without focus/split commands", async () => {
  const f = fixture();
  await Promise.all(["scout", "researcher", "worker"].map(name => presentCoreTerminal(name, "parent", `测试 ${name}`, f.core, { app: f.app })));
  const labels = f.calls.filter(c => c.method === "terminal.label");
  assert.equal(labels.length, 3);
  assert.equal(new Set(labels.map(c => c.params.labels["herdr.tab"])).size, 3);
  assert.ok(labels.every(c => c.params.labels["herdr.space"] === "parent-space"));
  assert.equal(f.commands.filter(c => c[0] === "do" && c[1] === "tab.rename").length, 3);
  assert.ok(f.commands.every(c => c[0] === "ls" || (c[0] === "do" && c[1] === "tab.rename")));
  assert.equal(f.calls.filter(c => c.method === "terminal.keep").length, 0);
});
it("can opt out without querying the app or core", async () => {
  process.env.PI_SUBAGENT_APP_LAYOUT = "hidden";
  try { const f = fixture(); await presentCoreTerminal("child", "parent", "child", f.core, { app: f.app }); assert.equal(f.calls.length, 0); assert.equal(f.commands.length, 0); }
  finally { delete process.env.PI_SUBAGENT_APP_LAYOUT; }
});
it("uses official parent labels if the CLI/window is absent, never launching an app", async () => {
  const f = fixture();
  await presentCoreTerminal("child", "parent", "child", f.core, { app: async () => { throw new Error("ENOENT"); } });
  assert.equal(f.calls.filter(c => c.method === "terminal.label").length, 1);
});
it("does not attach a headless caller or a caller in another window", async () => {
  const f = fixture();
  await presentCoreTerminal("child", "parent", "child", async () => ({ labels: {} }), { app: f.app });
  assert.equal(f.commands.length, 0);
  await presentCoreTerminal("child", "not-in-this-window", "child", f.core, { app: f.app });
  assert.equal(f.calls.filter(c => c.method === "terminal.label").length, 0);
});
it("does not repeat a layout mutation if adoption is slow", async () => {
  const f = fixture();
  await presentCoreTerminal("child", "parent", "child", f.core, { app: async () => snapshot(), timeout: 1 });
  assert.equal(f.calls.filter(c => c.method === "terminal.label").length, 1);
});
