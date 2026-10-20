import "./isolate.ts";
import { it, type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A fake herdr CLI: logs argv (calls separated by RS, args by NUL), answers from files in its dir.
const dir = mkdtempSync(join(tmpdir(), "herdr-test-"));
const log = join(dir, "log");
const fake = join(dir, "herdr");
const reply = (name: string, body: unknown) => writeFileSync(join(dir, name), JSON.stringify(body));
writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\0' "$@" >> ${JSON.stringify(log)}; printf '\\036' >> ${JSON.stringify(log)}
case "$1 $2" in
  "pane current") echo '{"result":{"pane":{"pane_id":"w1:p1","workspace_id":"w1"}}}' ;;
  "pane layout") cat ${JSON.stringify(join(dir, "layout"))} ;;
  "pane split") [ -e ${JSON.stringify(join(dir, "split_slow"))} ] && sleep 0.3; echo '{"result":{"pane":{"pane_id":"w1:p9"}}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w1:p8"},"tab":{}}}' ;;
  "agent list") [ -e ${JSON.stringify(join(dir, "list_fail"))} ] && { echo '{"error":{"code":"server_error","message":"down"}}' >&2; exit 1; }; cat ${JSON.stringify(join(dir, "list"))} 2>/dev/null || echo '{"result":{"agents":[{"name":"scout"}]}}' ;;
  "agent start") [ -e ${JSON.stringify(join(dir, "start_hang"))} ] && sleep 5; cat ${JSON.stringify(join(dir, "start"))}; [ -s ${JSON.stringify(join(dir, "start"))} ] && grep -q error ${JSON.stringify(join(dir, "start"))} && exit 1; true ;;
  "agent get") file=${JSON.stringify(join(dir, "agent"))}; [ -e "$file-$3" ] && file="$file-$3"; cat "$file"; grep -q error "$file" && exit 1; true ;;
  "pane close") [ -e ${JSON.stringify(join(dir, "close_fail"))} ] && { echo '{"error":{"code":"server_error","message":"busy"}}' >&2; exit 1; }; echo '{"result":{}}' ;;
  "pane read") printf '{not json\\nlast line\\n' ;;
  "integration status") cat ${JSON.stringify(join(dir, "status"))} ;;
  *) echo '{"result":{}}' ;;
esac
`);
chmodSync(fake, 0o755);
Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: fake });
delete process.env.HERDR_SOCKET_PATH;
const herdr = await import("../pi-extension/subagents/herdr.ts");
const calls = () => readFileSync(log, "utf8").split("\x1e").filter(Boolean).map((line) => line.split("\0").slice(0, -1));
const layout = (panes: [string, number, number][], zoomed = false) => reply("layout", {
  result: { layout: { zoomed, panes: panes.map(([pane_id, width, height]) => ({ pane_id, rect: { width, height } })) } },
});
const launch = { name: "Scout", args: ["--session", "/s s.jsonl"], env: { PI_SUBAGENT_NAME: "Scout" }, cwd: "/repo" };

it("starts a named agent in an unfocused split of the parent's own pane, else a background tab", async () => {
  writeFileSync(log, "");
  writeFileSync(join(dir, "start"), "");
  layout([["w1:p1", 90, 50], ["w1:p2", 200, 50]]);  // a bigger pane beside the parent is never split
  assert.deepEqual(await herdr.startAgent(launch), { surface: "w1:p9", agent: "scout-2" });
  const made = calls();
  assert.deepEqual(made[0], ["pane", "current", "--current"]);  // the caller's pane as herdr sees it now
  assert.deepEqual(made[2], ["pane", "split", "w1:p1", "--direction", "down", "--no-focus", "--cwd", "/repo", "--env", "PI_SUBAGENT_NAME=Scout"]);
  assert.deepEqual(made.at(-1), ["agent", "start", "scout-2", "--kind", "pi", "--pane", "w1:p9", "--timeout", "60000", "--", "--session", "/s s.jsonl"]);
  assert.equal(made.some(c => c[0] === "agent" && c[1] === "prompt"), false);

  for (const [panes, zoomed] of [[[["w1:p1", 60, 20], ["w1:p2", 200, 50]], false], [[["w1:p1", 200, 50]], true]] as const) {
    writeFileSync(log, "");
    layout(panes as any, zoomed);  // the parent is too small, or the tab is zoomed
    assert.equal((await herdr.startAgent(launch)).surface, "w1:p8");
    assert.deepEqual(calls()[2].slice(0, 7), ["tab", "create", "--workspace", "w1", "--no-focus", "--label", "Scout"]);
  }
});

it("defaults to readable 80-column by 24-row panes, otherwise opens a tab", async () => {
  for (const [width, height, direction] of [
    [220, 60, "right"],
    [110, 60, "down"],
    [160, 24, "right"],
    [80, 48, "down"],
    [159, 24, null],
    [80, 47, null],
    [110, 30, null],
    [55, 30, null],
  ] as const) {
    writeFileSync(log, "");
    writeFileSync(join(dir, "start"), "");
    layout([["w1:p1", width, height]]);
    const { surface } = await herdr.startAgent(launch);
    assert.equal(surface, direction ? "w1:p9" : "w1:p8", `${width}×${height}`);
    if (direction) assert.equal(calls()[2][4], direction);
  }
});

it("abandons a start on abort and closes the pane it opened", async () => {
  layout([["w1:p1", 200, 50]]);
  writeFileSync(join(dir, "start_hang"), "");
  writeFileSync(log, "");
  try {
    const controller = new AbortController();
    const started = herdr.startAgent(launch, controller.signal);
    while (!calls().some((c) => c[0] === "agent" && c[1] === "start")) await delay(10);
    controller.abort();
    await assert.rejects(started);
    assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
  } finally {
    rmSync(join(dir, "start_hang"));
  }
});

it("lets a pane creation finish on abort, then closes the pane", async () => {
  layout([["w1:p1", 200, 50]]);
  writeFileSync(join(dir, "split_slow"), "");
  writeFileSync(log, "");
  try {
    const controller = new AbortController();
    const started = herdr.startAgent(launch, controller.signal);
    while (!calls().some((c) => c[0] === "pane" && c[1] === "split")) await delay(10);
    controller.abort(); // herdr may already have created the pane
    await assert.rejects(started);
    assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
    assert.equal(calls().some((c) => c[0] === "agent" && c[1] === "start"), false);
  } finally {
    rmSync(join(dir, "split_slow"));
  }
});

it("queues only pane creation: a slow start does not hold up the next launch", async () => {
  layout([["w1:p1", 200, 50]]);
  writeFileSync(join(dir, "start_hang"), "");
  writeFileSync(log, "");
  const controller = new AbortController();
  try {
    const slow = herdr.startAgent(launch, controller.signal);
    while (!calls().some((c) => c[0] === "agent" && c[1] === "start")) await delay(10);
    const next = herdr.startAgent(launch, controller.signal);
    while (calls().filter((c) => c[0] === "pane" && c[1] === "split").length < 2) await delay(10);
    controller.abort();
    await Promise.allSettled([slow, next]);
  } finally {
    rmSync(join(dir, "start_hang"));
  }
});

it("retries closing a failed start's pane, and says when it stays open", async () => {
  layout([["w1:p1", 200, 50]]);
  reply("start", { error: { code: "agent_start_failed", message: "no pi" } });
  writeFileSync(join(dir, "close_fail"), "");
  writeFileSync(log, "");
  try {
    await assert.rejects(herdr.startAgent(launch), /herdr pane w1:p9 could not be closed/);
    assert.equal(calls().filter((c) => c[0] === "pane" && c[1] === "close").length, 3);
  } finally {
    rmSync(join(dir, "close_fail"));
    writeFileSync(join(dir, "start"), "");
  }
});

it("refuses a pi argument with a line break before opening a pane, as herdr would", async () => {
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent({ ...launch, args: ["--append-system-prompt", "line 1\nline 2"] }), /spans lines/);
  assert.deepEqual(calls(), [], "no pane was opened");
});

it("finds the live pi agent running a session file", async () => {
  const session = (value: string, kind = "path") => ({ agent: "pi", kind, source: "herdr:pi", value });
  reply("list", { result: { agents: [
    { agent: "claude", agent_session: session("/s/a.jsonl", "id"), pane_id: "w1:p2" }, // not a pi session path
    { agent: "pi", agent_session: session("/s/a.jsonl"), pane_id: "w1:p3" },            // unnamed: not ours
    { agent: "pi", name: "worker", agent_session: session("/s/a.jsonl"), pane_id: "w1:p4" },
  ] } });
  try {
    assert.deepEqual(await herdr.findSessionAgent("/s/a.jsonl"), { agent: "worker", pane: "w1:p4" });
    assert.equal(await herdr.findSessionAgent("/s/b.jsonl"), null);
  } finally {
    rmSync(join(dir, "list"));
  }
});

it("closes the pane on every start failure, explaining one that never became ready", async () => {
  layout([["w1:p1", 200, 50]]);
  for (const [code, expected] of [["agent_not_ready", /startup dialog \(such as trusting \/repo\)/], ["agent_start_failed", /agent_start_failed/]] as const) {
    reply("start", { error: { code, message: "no" } });
    writeFileSync(log, "");
    await assert.rejects(herdr.startAgent(launch), expected);
    assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
  }
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

it("closes the pane when listing agents fails after it was created", async () => {
  layout([["w1:p1", 200, 50]]);
  writeFileSync(join(dir, "start"), "");
  writeFileSync(join(dir, "list_fail"), "");
  writeFileSync(log, "");
  await assert.rejects(herdr.startAgent(launch), /server_error/);
  assert.deepEqual(calls().at(-1), ["pane", "close", "w1:p9"]);
  rmSync(join(dir, "list_fail"));
});

it("derives herdr agent names", () => {
  assert.equal(herdr.agentName("Scout: auth middleware", new Set()), "scout-auth-middleware");
  assert.equal(herdr.agentName("42", new Set()), "subagent");
  assert.equal(herdr.agentName("a".repeat(40), new Set()).length, 28);
});

it("reads raw pane text", async () => {
  assert.equal(await herdr.readScreen("w1:p9", 5), "{not json\nlast line");
});

it("decodes a quit marker as an early end", () => {
  assert.deepEqual(herdr.interpretExitSidecar({ type: "quit" }), { reason: "quit", exitCode: 1 });
});

it("follows the agent by name across pane moves, finishes on the exit marker, and calls an agent gone twice without one interrupted", async () => {
  const session = join(dir, "child.jsonl");
  const identity = { kind: "path", value: session };
  reply("agent", { result: { agent: { name: "scout", pane_id: "w1:p9", agent_status: "working", agent_session: identity } } });
  writeFileSync(`${session}.exit`, JSON.stringify({ type: "error", errorMessage: "overloaded" }));
  const signal = new AbortController().signal;
  // The marker is the result, but pi has exited only once herdr no longer lists it.
  let settled = false;
  const first = herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session });
  first.then(() => { settled = true; });
  await delay(30);
  assert.equal(settled, false, "other extensions may still be shutting down");
  reply("agent", { error: { code: "agent_not_found", message: "gone" } });
  assert.deepEqual(await first, { reason: "error", exitCode: 1, errorMessage: "overloaded" });
  reply("agent", { result: { agent: { name: "scout", pane_id: "w1:p9", agent_status: "working", agent_session: identity } } });
  // An agent herdr keeps listing is given up on after the grace period.
  assert.deepEqual(await herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session, exitGrace: 20 }),
    { reason: "error", exitCode: 1, errorMessage: "overloaded" });
  assert.equal(existsSync(`${session}.exit`), true, "the caller consumes the marker once the result is delivered");
  rmSync(`${session}.exit`);

  const seen: unknown[] = [];
  let ticks = 0;
  writeFileSync(log, "");
  const done = herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session, exitGrace: 0, onTick(status, pane) {
    seen.push([status, pane]);
    // The user moves the pane to another workspace: same agent name, new pane id.
    if (++ticks === 1) reply("agent", { result: { agent: { name: "scout", pane_id: "w2:p1", agent_status: "working", agent_session: identity } } });
    if (ticks === 2) writeFileSync(`${session}.exit`, JSON.stringify({ type: "done" }));
  } });
  assert.deepEqual(await done, { reason: "done", exitCode: 0 });
  assert.deepEqual(seen, [["working", "w1:p9"], ["working", "w2:p1"]]);
  rmSync(`${session}.exit`);
  assert.deepEqual([...new Set(calls().map((c) => c.join(" ")))], ["agent get scout"], "status is read by agent name, never a pane id");

  reply("agent", { error: { code: "agent_not_found", message: "gone" } }); // pi exited: herdr dropped the name
  const gone = await herdr.waitForExit("scout", signal, { interval: 1, sessionFile: session });
  assert.equal(gone.reason, "interrupted");
});

it("treats a reused name with a different session as exited, without adopting or reporting its pane", async () => {
  const session = join(dir, "original.jsonl");
  reply("agent", { result: { agent: { pane_id: "w2:p7", agent_status: "blocked", agent_session: { kind: "path", value: join(dir, "replacement.jsonl") } } } });
  assert.equal((await herdr.agentStatus("scout") as any).session, join(dir, "replacement.jsonl"));
  const ticks: unknown[] = [];
  assert.equal((await herdr.waitForExit("scout", new AbortController().signal, {
    interval: 1, sessionFile: session, onTick: (...args) => ticks.push(args),
  })).reason, "interrupted");
  assert.deepEqual(ticks, []);
  // Resolved paths establish identity; a missing report is not a mismatch.
  for (const agent_session of [undefined, { kind: "path", value: join(dir, "sub") + "/../original.jsonl" }]) {
    reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working", agent_session } } });
    const result = await herdr.waitForExit("scout", new AbortController().signal, {
      interval: 1, sessionFile: session, exitGrace: 0, onTick: () => writeFileSync(session + ".exit", '{"type":"done"}'),
    });
    assert.equal(result.reason, "done");
    rmSync(session + ".exit");
  }
});

async function fakeEvents(t: TestContext) {
  const path = join(dir, "events.sock");
  const requests: any[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      buffer = "";
      requests.push(request);
      socket.write(JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n");
      server.emit("subscription", socket);
    });
  });
  server.listen(path);
  await once(server, "listening");
  process.env.HERDR_SOCKET_PATH = path;
  t.after(async () => {
    delete process.env.HERDR_SOCKET_PATH;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { server, requests, sockets, subscribed: () => once(server, "subscription").then(([socket]) => socket as Socket) };
}

it("subscribes each watcher to its own pane, parses split/coalesced event lines, and checks only on events", { timeout: 5000 }, async t => {
  const events = await fakeEvents(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const session = join(dir, "event-child.jsonl");
  const otherSession = join(dir, "other-child.jsonl");
  const identity = { kind: "path", value: session };
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working", agent_session: identity } } });
  reply("agent-other", { result: { agent: { pane_id: "w1:p8", agent_status: "idle", agent_session: { kind: "path", value: otherSession } } } });
  t.after(() => rmSync(join(dir, "agent-other"), { force: true }));
  const seen: unknown[] = [];
  let blocked!: () => void;
  const statusChanged = new Promise<void>(resolve => { blocked = resolve; });
  const subscribed = events.subscribed();
  const main = herdr.waitForExit("scout", controller.signal, { interval: 20, sessionFile: session, exitGrace: 0, onTick(status, pane) {
    seen.push([status, pane]);
    if (status === "blocked") blocked();
  } });
  const socket = await subscribed;
  const otherSubscribed = events.subscribed();
  const other = herdr.waitForExit("other", controller.signal, { interval: 20, sessionFile: otherSession, exitGrace: 0 });
  await otherSubscribed;
  await delay(80); // let the first checks finish
  assert.deepEqual(events.requests.map(r => r.params.subscriptions[0].pane_id).sort(), ["w1:p8", "w1:p9"]);
  assert.deepEqual(events.requests[0].params.subscriptions.slice(1), [{ type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.moved" }]);
  const gets = () => calls().filter(c => c[0] === "agent" && c[1] === "get" && c[2] === "scout").length;
  const before = gets();
  await delay(80);
  assert.equal(gets(), before, "a healthy subscription does not poll");
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "blocked", agent_session: identity } } });
  const line = JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "w1:p9", agent_status: "blocked" } }) + "\n";
  socket.write(line.slice(0, 35));
  socket.write(line.slice(35) + JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "unrelated", agent_status: "done" } }) + "\n");
  await statusChanged;
  await delay(60);
  assert.equal(gets(), before + 1, "one event, one check; other panes' events are ignored");
  assert.deepEqual(seen.at(-1), ["blocked", "w1:p9"]);
  writeFileSync(`${otherSession}.exit`, JSON.stringify({ type: "done" }));
  assert.equal((await other).reason, "done");
  rmSync(`${otherSession}.exit`);
  writeFileSync(`${session}.exit`, JSON.stringify({ type: "error", errorMessage: "provider failed" }));
  socket.write(JSON.stringify({ event: "pane_exited", data: { pane_id: "w1:p9" } }) + "\n");
  assert.deepEqual(await main, { reason: "error", exitCode: 1, errorMessage: "provider failed" });
  rmSync(`${session}.exit`);
  await delay(20);
  assert.equal(events.sockets.size, 0, "each watcher closes its socket when done");
});

it("reconciles on events_lost and disconnect, polls while unavailable, and tears down on abort", { timeout: 5000 }, async t => {
  const events = await fakeEvents(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working" } } });
  const changes = new Map<unknown, () => void>();
  const status = (value: unknown) => new Promise<void>(resolve => changes.set(value, resolve));
  const subscribed = events.subscribed();
  const done = herdr.waitForExit("scout", controller.signal, { interval: 20, onTick(value) { changes.get(value)?.(); } });
  const rejected = assert.rejects(done, /Aborted/);
  let socket = await subscribed;
  await delay(60);
  let changed = status("blocked");
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "blocked" } } });
  socket.write(JSON.stringify({ id: "subagents", error: { code: "events_lost", message: "lagged" } }) + "\n");
  await changed;
  changed = status("idle");
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "idle" } } });
  await changed; // fallback keeps today's polling until the socket reconnects
  socket = await events.subscribed();
  await delay(60);
  changed = status(null);
  reply("agent", { error: { code: "server_error", message: "unavailable" } });
  socket.destroy();
  await changed;
  controller.abort();
  await rejected;
  await delay(1100);
  assert.equal(events.requests.length, 2, "abort cancels the reconnect timer");
  assert.equal(events.sockets.size, 0);
});

it("a close event confirms interruption twice, but a late marker still wins", { timeout: 5000 }, async t => {
  const events = await fakeEvents(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const session = join(dir, "late-event.jsonl");
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working", agent_session: { kind: "path", value: session } } } });
  const subscribed = events.subscribed();
  const done = herdr.waitForExit("scout", controller.signal, { interval: 80, sessionFile: session, exitGrace: 0 });
  const socket = await subscribed;
  await delay(60);
  writeFileSync(log, "");
  reply("agent", { error: { code: "agent_not_found", message: "gone" } });
  socket.write(JSON.stringify({ event: "pane.closed", data: { pane_id: "w1:p9" } }) + "\n");
  await delay(40);
  assert.equal(calls().length, 1);
  writeFileSync(`${session}.exit`, JSON.stringify({ type: "quit" }));
  assert.deepEqual(await done, { reason: "quit", exitCode: 1 });
  assert.equal(calls().length, 1, "the marker wins before a second CLI check");
  assert.equal((await herdr.waitForExit("scout", controller.signal, { interval: 20 })).reason, "interrupted");
});

it("refreshes subscriptions after a pane move and reconciles periodically even with a healthy socket", { timeout: 5000 }, async t => {
  const events = await fakeEvents(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working" } } });
  let changed!: () => void;
  const idle = new Promise<void>(resolve => { changed = resolve; });
  const subscribed = events.subscribed();
  const done = herdr.waitForExit("scout", controller.signal, { interval: 20, onTick(status) { if (status === "idle") changed(); } });
  const rejected = assert.rejects(done, /Aborted/);
  const socket = await subscribed;
  await delay(60);
  const moved = events.subscribed();
  reply("agent", { result: { agent: { pane_id: "w2:p1", agent_status: "working" } } });
  socket.write(JSON.stringify({ event: "pane_moved", data: {} }) + "\n");
  await moved;
  await delay(60);
  assert.deepEqual(events.requests.at(-1).params.subscriptions[0], { type: "pane.agent_status_changed", pane_id: "w2:p1" });
  reply("agent", { result: { agent: { pane_id: "w2:p1", agent_status: "idle" } } });
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + 15_001);
  await idle; // no event: the safety reconcile alone finds the new status
  controller.abort();
  await rejected;
});

it("uses the original polling when the socket cannot connect", async t => {
  process.env.HERDR_SOCKET_PATH = join(dir, "missing.sock");
  t.after(() => { delete process.env.HERDR_SOCKET_PATH; });
  const session = join(dir, "fallback.jsonl");
  reply("agent", { result: { agent: { pane_id: "w1:p9", agent_status: "working", agent_session: { kind: "path", value: session } } } });
  let ticks = 0;
  const done = await herdr.waitForExit("scout", new AbortController().signal, { interval: 10, sessionFile: session, exitGrace: 0, onTick() {
    if (++ticks === 2) writeFileSync(`${session}.exit`, JSON.stringify({ type: "done" }));
  } });
  assert.equal(done.reason, "done");
  assert.equal(ticks, 2);
});

it("finds where herdr installed the pi integration, so children elsewhere can load it", async () => {
  const installed = join(dir, "pi-config", "extensions", "herdr-agent-state.ts");
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, "");
  writeFileSync(join(dir, "status"), `pi: current (v9) (${installed})\nomp: not installed (/y)\n`);
  assert.equal(await herdr.ensurePiIntegration(), false);
  assert.equal(herdr.piIntegrationPath(), installed);
  rmSync(installed);
  assert.equal(herdr.piIntegrationPath(), null, "not once it is gone");
});

it("installs the pi integration only when it is not current", async () => {
  writeFileSync(join(dir, "status"), "pi: current (v9) (/x)\nomp: not installed (/y)\n");
  writeFileSync(log, "");
  assert.equal(await herdr.ensurePiIntegration(), false);
  writeFileSync(join(dir, "status"), "pi: not installed (/x)\n");
  assert.equal(await herdr.ensurePiIntegration(), true);
  assert.deepEqual(calls().slice(-2), [["integration", "install", "pi"], ["integration", "status"]], "then reads where it went");
  rmSync(dir, { recursive: true, force: true });
});
