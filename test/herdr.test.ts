import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake herdr CLI: logs argv (calls separated by RS, args by NUL), answers from files in its dir.
const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
const log = join(dir, "log");
const fake = join(dir, "herdr");
const reply = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body));
writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\0' "$@" >> ${JSON.stringify(log)}; printf '\\036' >> ${JSON.stringify(log)}
case "$1 $2" in
  "pane layout") cat ${JSON.stringify(join(dir, "layout"))} ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"w1:p9"}}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w1:p8"},"tab":{}}}' ;;
  "agent list") [ -e ${JSON.stringify(join(dir, "list_fail"))} ] && { echo '{"error":{"code":"server_error","message":"down"}}' >&2; exit 1; }; echo '{"result":{"agents":[{"name":"scout"}]}}' ;;
  "agent start") cat ${JSON.stringify(join(dir, "start"))}; [ -s ${JSON.stringify(join(dir, "start"))} ] && grep -q error ${JSON.stringify(join(dir, "start"))} && exit 1; true ;;
  "agent prompt") [ "$3" = blocked ] && { echo '{"error":{"code":"agent_blocked","message":"blocked"}}' >&2; exit 1; }; echo '{"result":{}}' ;;
  "agent get") cat ${JSON.stringify(join(dir, "agent"))}; grep -q error ${JSON.stringify(join(dir, "agent"))} && exit 1; true ;;
  "pane read") printf '{not json\\nlast line\\n' ;;
  "integration status") cat ${JSON.stringify(join(dir, "status"))} ;;
  *) echo '{"result":{}}' ;;
esac
`);
chmodSync(fake, 0o755);
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: fake });
const herdr = await import("../pi-extension/subagents/herdr.ts");
const calls = () => readFileSync(log, "utf8").split("\x1e").filter(Boolean).map((line) => line.split("\0").slice(0, -1));
const layout = (panes: [string, number, number][], zoomed = false) => reply("layout", {
  result: { layout: { zoomed, panes: panes.map(([pane_id, width, height]) => ({ pane_id, rect: { width, height } })) } },
});
const launch = { name: "Scout", kind: "pi" as const, args: ["--session", "/s s.jsonl"], prompts: ["/skill:review", "line 1\nline 2"], env: { PI_SUBAGENT_NAME: "Scout" }, cwd: "/repo" };

it("starts a named agent in an unfocused split of the largest usable pane, else a background tab", async () => {
  writeFileSync(log, "");
  writeFileSync(join(dir, "start"), "");
  layout([["w1:p1", 90, 50], ["w1:p2", 200, 50]]);
  assert.deepEqual(await herdr.startAgent(launch), { surface: "w1:p9", agent: "scout-2" });
  const made = calls();
  assert.deepEqual(made[1], ["pane", "split", "w1:p2", "--direction", "right", "--no-focus", "--cwd", "/repo", "--env", "PI_SUBAGENT_NAME=Scout"]);
  assert.deepEqual(made.slice(-3), [
    ["agent", "start", "scout-2", "--kind", "pi", "--pane", "w1:p9", "--timeout", "60000", "--", "--session", "/s s.jsonl"],
    ["agent", "prompt", "scout-2", "/skill:review"],
    ["agent", "prompt", "scout-2", "line 1\nline 2"],
  ]);

  writeFileSync(log, "");
  layout([["w1:p1", 200, 50]], true);
  assert.equal((await herdr.startAgent(launch)).surface, "w1:p8");
  assert.deepEqual(calls()[1].slice(0, 5), ["tab", "create", "--no-focus", "--label", "Scout"]);
});

it("leaves a pane blocked at startup for the user and closes it on other start failures", async () => {
  layout([["w1:p1", 200, 50]]);
  reply("start", { error: { code: "agent_not_ready", message: "blocked" } });
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent(launch), /blocked at a startup dialog in herdr pane w1:p9/);
  assert.equal(calls().some((c) => c[0] === "pane" && c[1] === "close"), false);
  writeFileSync(log, "");
  reply("start", { error: { code: "agent_start_failed", message: "no pi" } });
  await assert.rejects(herdr.startAgent(launch), /agent_start_failed/);
  assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
  writeFileSync(join(dir, "start"), "");
});

it("picks another name once when a parallel start took it, and keeps the pane's output when pi fails to start", async () => {
  layout([["w1:p1", 200, 50]]);
  reply("start", { error: { code: "agent_name_taken", message: "taken" } });
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent(launch), (error: any) => /agent_name_taken/.test(error.message) && /last line/.test(error.message));
  assert.equal(calls().filter((c) => c[0] === "agent" && c[1] === "start").length, 2, "one retry, not more");
  reply("start", { error: { code: "timeout", message: "timed out" } });
  await assert.rejects(herdr.startAgent(launch), /timeout[\s\S]*Last output in the pane:\n\{not json\nlast line/);
  writeFileSync(join(dir, "start"), "");
});

it("closes the pane when listing agents or submitting the task fails after it was created", async () => {
  layout([["w1:p1", 200, 50]]);
  writeFileSync(join(dir, "start"), "");
  writeFileSync(join(dir, "list_fail"), "");
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent(launch), /server_error/);
  assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
  rmSync(join(dir, "list_fail"));
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent({ ...launch, name: "blocked" }), /agent_blocked/);  // the fake refuses prompts to "blocked"
  assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
});

it("derives herdr agent names", () => {
  assert.equal(herdr.agentName("Scout: auth middleware", new Set()), "scout-auth-middleware");
  assert.equal(herdr.agentName("42", new Set()), "subagent");
  assert.equal(herdr.agentName("a".repeat(40), new Set()).length, 28);
});

it("steers as one multi-line prompt, reads raw text, and reports herdr errors by code", () => {
  writeFileSync(log, "");
  herdr.steer("w1:p9", "a\nb");
  assert.deepEqual(calls()[0], ["agent", "prompt", "w1:p9", "a\nb"]);
  assert.throws(() => herdr.steer("blocked", "hi"), (error: any) => error.code === "agent_blocked");
  assert.equal(herdr.readScreen("w1:p9", 5), "{not json\nlast line");
});

it("decodes a quit marker as an early end", () => {
  assert.deepEqual(herdr.interpretExitSidecar({ type: "quit" }), { reason: "quit", exitCode: 1 });
});

it("follows the agent by name across pane moves, finishes on the exit marker, and calls an agent gone twice without one interrupted", async () => {
  const session = join(dir, "child.jsonl");
  reply("agent", { result: { agent: { name: "scout", pane_id: "w1:p9", agent_status: "working" } } });
  writeFileSync(`${session}.exit`, JSON.stringify({ type: "error", errorMessage: "overloaded" }));
  const signal = new AbortController().signal;
  assert.deepEqual(await herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session }),
    { reason: "error", exitCode: 1, errorMessage: "overloaded" });
  assert.equal(existsSync(`${session}.exit`), false);

  const seen: unknown[] = [];
  let ticks = 0;
  writeFileSync(log, "");
  const done = herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session, onTick(status, pane) {
    seen.push([status, pane]);
    // The user moves the pane to another workspace: same agent name, new pane id.
    if (++ticks === 1) reply("agent", { result: { agent: { name: "scout", pane_id: "w2:p1", agent_status: "working" } } });
    if (ticks === 2) writeFileSync(`${session}.exit`, JSON.stringify({ type: "done" }));
  } });
  assert.deepEqual(await done, { reason: "done", exitCode: 0 });
  assert.deepEqual(seen, [["working", "w1:p9"], ["working", "w2:p1"]]);
  assert.deepEqual([...new Set(calls().map((c) => c.join(" ")))], ["agent get scout"], "status is read by agent name, never a pane id");

  reply("agent", { error: { code: "agent_not_found", message: "gone" } }); // pi exited: herdr dropped the name
  const gone = await herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session });
  assert.equal(gone.reason, "interrupted");
  assert.deepEqual(await herdr.waitForExit("scout", signal, { interval: 1, exitIsDone: true }), { reason: "done", exitCode: 0 });
});

it("installs the pi integration only when it is not current", async () => {
  writeFileSync(join(dir, "status"), "pi: current (v9) (/x)\nomp: not installed (/y)\n");
  writeFileSync(log, "");
  assert.equal(await herdr.ensurePiIntegration(), false);
  writeFileSync(join(dir, "status"), "pi: not installed (/x)\n");
  assert.equal(await herdr.ensurePiIntegration(), true);
  assert.deepEqual(calls().at(-1), ["integration", "install", "pi"]);
  rmSync(dir, { recursive: true, force: true });
});
