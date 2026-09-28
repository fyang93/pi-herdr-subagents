import { it, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { selectPlacement, splitDirection, positiveInteger } from "../pi-extension/subagents/zellij-layout.ts";
import {
  isZellijAvailable, __pollForExitTest__,
  sendCommand, readScreen, readScreenAsync, closeSurface, pollForExit, shellEscape, withProcessId,
} from "../pi-extension/subagents/zellij.ts";

it("prefers safe siblings before splitting the parent, otherwise chooses a new tab", () => {
  const pane = (id: number, rows = 40, columns = 120, extra = {}) => ({
    id, is_plugin: false, pane_rows: rows, pane_columns: columns, tab_id: 1, ...extra,
  });
  assert.equal(splitDirection(pane(0)), "right", "prefer right even when both directions fit");
  assert.equal(splitDirection(pane(0, 12, 104)), "right");
  assert.equal(splitDirection(pane(0, 24, 103)), "down");
  assert.equal(splitDirection(pane(0, 23, 103)), null);
  assert.equal(splitDirection(pane(0, 10, 100)), null, "outer dimensions are not usable content");
  assert.equal(splitDirection(pane(0, 40, 49)), null);
  assert.equal(splitDirection(pane(0, 9, 200)), null);
  assert.equal(splitDirection(pane(0, 34, 164), 80, 15), "right");
  assert.equal(splitDirection(pane(0, 34, 163), 80, 15), "down");
  assert.equal(splitDirection(pane(0, 33, 163), 80, 15), null);
  assert.equal(splitDirection(pane(0, 24, 104, { pane_content_columns: 100, pane_content_rows: 22 })), "down");
  assert.deepEqual(selectPlacement([pane(0)], 0), { paneId: 0, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0), pane(1)], 0), { paneId: 1, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0, 80, 200), pane(1)], 0), { paneId: 1, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0), pane(1, 24, 60)], 0), { paneId: 1, direction: "down" });
  assert.deepEqual(selectPlacement([pane(0), pane(1, 10, 60)], 0), { paneId: 0, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0, 10, 60), pane(1, 20, 120)], 0), { paneId: 1, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0), pane(1), pane(2, 80, 200)], 0), { paneId: 2, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0, 100, 47), pane(1, 31, 77)], 0), { paneId: 1, direction: "down" });
  assert.equal(selectPlacement([pane(0, 5, 10), pane(1, 6, 8)], 0), "new-tab");
  assert.equal(selectPlacement([pane(0, 5, 10)], 0), "new-tab", "do not split below the configured minimum");
  const mixed = [pane(0, 5, 10), pane(1, 10, 60), pane(2, 10, 80),
    pane(3, 80, 200, { is_plugin: true }), pane(4, 80, 200, { is_floating: true }),
    pane(5, 80, 200, { is_suppressed: true }), pane(6, 80, 200, { is_selectable: false }),
    pane(7, 80, 200, { tab_id: 2 })];
  assert.equal(selectPlacement(mixed, 0), "new-tab");
  assert.equal(selectPlacement(mixed, 99), null);
  assert.deepEqual(selectPlacement([
    pane(0, 50, 90), pane(128, 50, 89, { exited: true }),
  ], 0), { paneId: 128, direction: "down" }, "visible exited sibling must be used before the main session");
  assert.deepEqual(selectPlacement([
    pane(0, 50, 90), pane(128, 50, 89, { exited: true, is_suppressed: true }),
  ], 0), { paneId: 0, direction: "down" }, "suppressed panes are not visible split targets");
  assert.equal(selectPlacement([pane(0), pane(1)], 0, 100, 30), "new-tab");
  assert.equal(selectPlacement([pane(0), pane(1, 40, 120, { pane_rows: undefined })], 0), null);
  assert.equal(selectPlacement([pane(0), pane(1, 40, 120, { pane_content_rows: 41 })], 0), null);
  assert.equal(selectPlacement([pane(0, 40, 120, { is_fullscreen: true }), pane(1)], 0), "new-tab");
  assert.equal(selectPlacement([pane(0, 40, 120, { is_floating: true }), pane(1)], 0), "new-tab");
  assert.equal(selectPlacement([pane(0)], 0, 50, 10, 80, 20), "new-tab", "honor higher parent minimums");
  assert.deepEqual(selectPlacement([pane(0), pane(1)], 0, 50, 10, 80, 20), { paneId: 1, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0, 50, 179)], 0, 50, 10, 80, 20), { paneId: 0, direction: "right" });
  assert.deepEqual(selectPlacement([pane(0), pane(1)], 0, 80, 15), { paneId: 1, direction: "down" });
  for (const value of [undefined, "0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.equal(positiveInteger(value, 50), 50);
  }
  assert.equal(positiveInteger("80", 50), 80);
});

it("routes Zellij commands by id and rejects old CLI versions", () => {
  const originalEnv = { ...process.env };
  const calls: { command: string; args: string[]; options: any }[] = [];
  let version = "zellij 0.43.1";
  mock.method(childProcess, "execFileSync", (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (command === "sh") return "";
    assert.equal(command, "zellij");
    if (args[0] === "--version") return version;
    if (args[1] === "dump-screen") {
      writeFileSync(args[args.indexOf("--path") + 1], "old\n__SUBAGENT_DONE_0__\n\n");
      return "";
    }
    return "";
  });
  syncBuiltinESMExports();
  try {
    delete process.env.ZELLIJ;
    assert.equal(isZellijAvailable(), false);
    assert.throws(() => sendCommand("terminal_12", "outside"), /Zellij is not available/);
    process.env.ZELLIJ = "0"; // Real Zellij value, not a false flag.
    process.env.ZELLIJ_PANE_ID = "0";
    assert.equal(isZellijAvailable(), true);
    assert.throws(() => sendCommand("terminal_12", "old"), /0\.44\+/);
    version = "zellij 0.44.3";
    sendCommand("terminal_12", "-literal $HOME");
    assert.deepEqual(calls.slice(-2).map(c => c.args), [
      ["action", "write-chars", "--pane-id", "terminal_12", "--", "-literal $HOME"],
      ["action", "write", "--pane-id", "terminal_12", "13"],
    ]);
    assert.equal(readScreen("terminal_12", 1), "__SUBAGENT_DONE_0__");
    const dump = calls.at(-1)!;
    assert.equal(existsSync(dump.args[dump.args.indexOf("--path") + 1]), false);
    assert.equal(dump.options.timeout, 10000);
    assert.throws(() => closeSurface(""), /Invalid terminal/);
    assert.throws(() => sendCommand("plugin_1", "exit"), /Invalid terminal/);
    closeSurface("terminal_12");
    assert.deepEqual(calls.at(-1)!.args, ["action", "close-pane", "--pane-id", "terminal_12"]);
    delete process.env.ZELLIJ;
    assert.throws(() => sendCommand("terminal_12", "hello"), /Zellij is not available/);
  } finally {
    process.env = originalEnv;
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

it("recovers only its own pane, reads large UTF-8 tails, retries transient reads and supports abort", async () => {
  const originalEnv = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "pi-zellij-unit-"));
  const state = join(dir, "state.json");
  const large = join(dir, "large");
  const payload = "old".repeat(800000) + "\n" + "中文🙂".repeat(12000) + "\nlast\n\n";
  writeFileSync(large, payload);
  writeFileSync(join(dir, "zellij"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), state = process.env.FAKE_STATE;
if (args[0] === '--version') { console.log(process.env.FAKE_VERSION || 'zellij 0.44.3'); process.exit(); }
let s = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : { creates: 0 };
const save = () => fs.writeFileSync(state, JSON.stringify(s));
switch (args[1]) {
 case 'new-pane': s.creates++; s.marker = args.at(-1); s.parent = process.env.ZELLIJ_PANE_ID; save(); break; // Lost ID reply.
 case 'rename-pane': s.renamed = args.at(-1); s.renamedPane = args[args.indexOf('--pane-id') + 1]; save(); break;
 case 'list-panes':
   if (args.includes('--geometry')) { console.log(JSON.stringify([0,5].map(id => ({id,is_plugin:false,tab_id:id,pane_rows:50,pane_columns:180})))); break; }
   if (process.env.FAKE_MODE === 'slow-list') { setTimeout(() => {}, 30000); break; }
   console.log(JSON.stringify(process.env.FAKE_MODE === 'missing' ? [] : [
   { id: 99, is_plugin: true, title: s.marker },
   { id: 98, is_plugin: false, title: 'worker' },
   { id: 7, is_plugin: false, title: s.marker }
 ])); break;
 case 'dump-screen':
   if (process.env.FAKE_MODE === 'hang') { setTimeout(() => {}, 30000); break; }
   if (process.env.FAKE_MODE === 'missing') break;
   if (process.env.FAKE_MODE === 'transient') {
     s.reads = (s.reads || 0) + 1; save();
     if (s.reads <= 4) process.exit(2);
   }
   if (args.includes('--path')) {
     s.dump = args[args.indexOf('--path') + 1]; save();
     if (process.env.FAKE_MODE === 'fail') process.exit(2);
     fs.copyFileSync(process.env.FAKE_LARGE, s.dump);
   } else console.log('task output\\n__SUBAGENT_DONE_7__');
}
`, { mode: 0o700 });
  try {
    Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, ZELLIJ: "0", ZELLIJ_PANE_ID: "0", FAKE_STATE: state, FAKE_LARGE: large });
    // Fresh version cache also exercises async startup validation.
    const { createSurface: create } = await import("../pi-extension/subagents/zellij.ts?async-unit");
    process.env.FAKE_VERSION = "zellij 0.43.1";
    await assert.rejects(create("old"), /0\.44\+/);
    delete process.env.FAKE_VERSION;
    delete process.env.ZELLIJ;
    await assert.rejects(create("outside"), /Zellij is not available/);
    process.env.ZELLIJ = "0";
    await assert.rejects(create("invalid", "invalid-pane"), /valid ZELLIJ_PANE_ID/);
    assert.equal(await create("worker", "terminal_5"), "terminal_7");
    assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), {
      creates: 1, marker: JSON.parse(readFileSync(state, "utf8")).marker,
      parent: "5", renamed: "worker", renamedPane: "terminal_7",
    });
    assert.equal(process.env.ZELLIJ_PANE_ID, "0");
    const expected = payload.trimEnd().split("\n").slice(-2).join("\n");
    assert.equal(readScreen("terminal_7", 2), expected);
    assert.equal(await readScreenAsync("terminal_7", 2), expected);
    // Compare with the original string semantics, including long single lines,
    // empty lines, Unicode whitespace and UTF-8 boundaries between disk blocks.
    for (const text of [payload, "\n\n", "head\n" + "\u3000".repeat(50000),
      "α\n\nβ\n" + "🙂".repeat(20000) + "\nlast\u2003\n",
      "🙂".repeat(2_000_000)]) {
      writeFileSync(large, text);
      for (const lines of [0, 1, 2, 4]) {
        assert.equal(readScreen("terminal_7", lines), text.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n"));
      }
    }
    writeFileSync(large, payload);
    assert.equal(existsSync(JSON.parse(readFileSync(state, "utf8")).dump), false);
    assert.equal((await pollForExit("terminal_7", AbortSignal.timeout(5000), { interval: 1 })).exitCode, 7);
    process.env.FAKE_MODE = "slow-list";
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    const recoveryStart = performance.now();
    try {
      await assert.rejects(create("worker"), /not retried to avoid duplicate tasks/);
    } finally { clearInterval(heartbeat); }
    assert.ok(ticks > 20, "recovery must not block the event loop");
    assert.ok(performance.now() - recoveryStart < 3500, "a stalled query must respect the 2s recovery budget");
    assert.equal(JSON.parse(readFileSync(state, "utf8")).creates, 2, "an ambiguous creation must never be replayed");
    process.env.FAKE_MODE = "transient";
    assert.equal((await pollForExit("terminal_7", AbortSignal.timeout(5000), { interval: 1 })).exitCode, 7);
    assert.equal(JSON.parse(readFileSync(state, "utf8")).reads, 5, "four temporary CLI errors must not terminate a working task");
    process.env.FAKE_MODE = "missing";
    __pollForExitTest__.clearPaneSample();
    assert.equal((await pollForExit("terminal_7", AbortSignal.timeout(10000), { interval: 100 })).reason, "interrupted");
    process.env.FAKE_MODE = "fail";
    await assert.rejects(readScreenAsync("terminal_7"));
    assert.equal(existsSync(JSON.parse(readFileSync(state, "utf8")).dump), false);
    process.env.FAKE_MODE = "hang";
    const start = Date.now();
    await assert.rejects(pollForExit("terminal_7", AbortSignal.timeout(100), { interval: 1 }), /Aborted/);
    assert.ok(Date.now() - start < 2000, "abort must interrupt an in-flight CLI read");
  } finally {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("detects killed processes without mistaking idle processes or failed pane queries for exits", async () => {
  const originalEnv = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "pi-exit-test-"));
  const pidFile = join(dir, "child ' pid");
  const cliLog = join(dir, "cli.log");
  writeFileSync(join(dir, "zellij"), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2), mode = process.env.EXIT_TEST_MODE;
fs.appendFileSync(process.env.EXIT_TEST_LOG, JSON.stringify(args) + '\\n');
if(args[0] === '--version') console.log('zellij 0.44.3');
else if(mode === 'cli-error') process.exit(2);
else if(args[1] === 'dump-screen') { if(mode === 'complete') console.log('__SUBAGENT_DONE_0__'); }
else if(args[1] === 'list-panes') console.log(mode === 'invalid' ? '{}' : JSON.stringify([{id:7,is_plugin:false,tab_id:42}]));
`, { mode: 0o700 });
  const args = ["space value", "quote'\";$HOME\nnext"];
  const code = `console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(1),cwd:process.cwd(),env:process.env.EXIT_TEST_ENV})); process.stdin.resume();`;
  const command = withProcessId(`${shellEscape(process.execPath)} -e ${shellEscape(code)} ${args.map(shellEscape).join(" ")}`, pidFile);
  const child = childProcess.spawn("bash", ["-c", `exec ${command}`], {
    cwd: dir, env: { ...process.env, EXIT_TEST_ENV: "preserved" }, stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const [output] = await once(child.stdout, "data");
    const ready = JSON.parse(output.toString());
    assert.deepEqual(ready, { pid: child.pid, args, cwd: dir, env: "preserved" });
    assert.equal(Number(readFileSync(pidFile, "utf8")), child.pid, "exec must preserve the recorded PID");
    Object.assign(process.env, { PATH: `${dir}:${originalEnv.PATH}`, ZELLIJ: "0", EXIT_TEST_LOG: cliLog, EXIT_TEST_MODE: "idle" });
    const options = { interval: 1, pidFile };
    const staysRunning = async () => {
      const cancel = new AbortController();
      let ticks = 0;
      await assert.rejects(pollForExit("terminal_7", AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]), {
        ...options, onTick() { if (++ticks === 3) cancel.abort(); },
      }), /Aborted/);
      assert.equal(ticks, 3, "must survive multiple successful liveness checks, not merely time out before probing");
    };
    await staysRunning(); // A silent, waiting process is still alive, even in another tab.
    child.kill("SIGSTOP");
    await staysRunning(); // Suspended is not exited either.
    child.kill("SIGCONT");
    assert.ok(!readFileSync(cliLog, "utf8").includes('"list-panes"'), "healthy PID + successful screen reads need no pane queries");
    for (const mode of ["cli-error", "invalid"]) {
      process.env.EXIT_TEST_MODE = mode;
      __pollForExitTest__.clearPaneSample();
      await staysRunning();
    }
    process.env.EXIT_TEST_MODE = "idle";
    __pollForExitTest__.clearPaneSample();
    rmSync(pidFile);
    await staysRunning();
    for (const text of ["", "invalid", "-1", "0", "1.5"]) {
      writeFileSync(pidFile, text);
      await staysRunning(); // Missing/invalid startup metadata is not proof of death.
    }
    writeFileSync(pidFile, String(child.pid));
    const probe = mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    try { await staysRunning(); } finally { probe.mock.restore(); }

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const result = await pollForExit("terminal_7", AbortSignal.timeout(5000), options);
    assert.equal(result.reason, "interrupted");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage!, /process .* exited/);

    const { __test__: api } = await import("../pi-extension/subagents/index.ts");
    for (const cli of ["pi", "claude"]) {
      const running = { id: `killed-${cli}`, name: "killed", task: "test", cli, surface: "terminal_7", pidFile,
        sessionFile: join(dir, "session.jsonl"), startTime: Date.now() };
      api.runningSubagents.set(running.id, running as any);
      let closes = 0;
      const watched = await api.watchSubagent(running as any, AbortSignal.timeout(5000), {
        poll: (surface, signal, options) => pollForExit(surface, signal, { ...options, interval: 1 }),
        observe: () => {}, close: () => { closes++; },
      });
      assert.equal(watched.error, "interrupted");
      assert.equal(watched.exitCode, 1);
      assert.match(watched.summary, /process .* exited/);
      assert.equal(watched.errorMessage, undefined, "must not mislabel interruption as a provider error");
      assert.equal(api.runningSubagents.has(running.id), false);
      assert.equal(closes, 0, "leave the surviving shell or reused pane alone");
    }

    // Even after a confirmed OS exit, a late shell completion marker takes priority.
    let ticks = 0;
    const completed = await pollForExit("terminal_7", AbortSignal.timeout(5000), {
      ...options, onTick() { ticks++; process.env.EXIT_TEST_MODE = "complete"; },
    });
    assert.equal(ticks, 1);
    assert.deepEqual(completed, { reason: "sentinel", exitCode: 0 });

    const mustNotRun = join(dir, "unexpected-child");
    const badCommand = withProcessId(`touch ${shellEscape(mustNotRun)}`, join(dir, "missing-directory", "pid"));
    assert.notEqual(childProcess.spawnSync("bash", ["-c", badCommand]).status, 0);
    assert.equal(existsSync(mustNotRun), false, "a PID write failure must not launch an untracked process");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
