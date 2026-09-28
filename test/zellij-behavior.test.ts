import { it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSurface, pollForExit, __pollForExitTest__ as hooks } from "../pi-extension/subagents/zellij.ts";

// Fake CLI still uses real child processes: verify async behavior, argv and IPC
// sharing without modifying the user's Zellij session or making LLM calls.
function fixture(script: string) {
  const env = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "pi-zellij-behavior-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(join(dir, "zellij"), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({args, parent: process.env.ZELLIJ_PANE_ID}) + '\\n');
if (args[0] === '--version') { console.log(process.env.TEST_VERSION || 'zellij 0.45.1'); process.exit(); }
${script}
`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${dir}:${env.PATH}`, ZELLIJ: "0", ZELLIJ_PANE_ID: "0",
    ZELLIJ_SESSION_NAME: dir, TEST_LOG: log, TEST_DIR: dir });
  delete process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS;
  delete process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS;
  hooks.clearPaneSample();
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)),
    close() { process.env = env; hooks.clearPaneSample(); rmSync(dir, { recursive: true, force: true }); } };
}

it("serializes async tiled placement and opens a background tab when space runs out", async () => {
  const f = fixture(`
const stateFile = process.env.TEST_DIR + '/state';
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {count:0};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[1] === 'list-panes') {
  if (process.env.BAD_LAYOUT === '1') { console.log('{}'); process.exit(); }
  const pane = (id, rows, columns, tab = 9) => ({id, is_plugin:false, tab_id:tab, pane_rows:rows, pane_columns:columns});
  if (args.includes('--geometry')) console.log(JSON.stringify(state.count ? [pane(0,10,70),pane(1,10,60)] : [pane(0,50,140)]));
  else console.log(JSON.stringify([{id:0,is_plugin:false,tab_id:9},{id:20,is_plugin:false,title:state.marker,tab_id:10,tab_name:state.marker}]));
} else if (args[1] === 'new-pane') {
  setTimeout(() => { state.count++; save(); console.log('terminal_' + state.count); }, 80);
} else if (args[1] === 'new-tab') {
  state.marker = args[args.indexOf('--name') + 1]; save(); console.log('10');
}
`);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    await assert.rejects(createSurface("invalid", "bad-parent"), /valid ZELLIJ_PANE_ID/);
    assert.deepEqual(await Promise.all([createSurface("first"), createSurface("second")]), ["terminal_1", "terminal_20"]);
    const actions = f.calls().filter(c => c.args[0] === "action");
    assert.deepEqual(actions.map(c => c.args[1]), ["list-panes", "new-pane", "rename-pane", "list-panes", "new-tab", "list-panes", "rename-tab", "rename-pane"]);
    const split = actions.find(c => c.args[1] === "new-pane")!;
    const tab = actions.find(c => c.args[1] === "new-tab")!;
    assert.equal(split.parent, "0");
    assert.ok(split.args.includes("--near-current-pane") && !split.args.includes("--stacked"));
    assert.equal(split.args[split.args.indexOf("--direction") + 1], "right");
    assert.ok(tab.args.includes("--no-focus"), "new tab must not steal client focus");
    assert.ok(!tab.args.includes("--stacked"));
    assert.ok(actions.find(c => c.args[1] === "rename-tab")!.args.includes("10"));
    assert.ok(ticks > 10, "CLI waits must not block the parent event loop");
    assert.equal(process.env.ZELLIJ_PANE_ID, "0");
    process.env.BAD_LAYOUT = "1";
    assert.equal(await createSurface("fallback"), "terminal_2");
    assert.equal(f.calls().filter(c => c.args[1] === "new-pane").length, 2,
      "unavailable geometry uses native placement without replaying a creation");
  } finally { clearInterval(timer); f.close(); }
});

it("targets a visible exited sibling explicitly instead of shrinking the larger parent", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') console.log(JSON.stringify([
  {id:0,is_plugin:false,tab_id:9,pane_rows:80,pane_columns:200},
  {id:7,is_plugin:false,tab_id:9,pane_rows:20,pane_columns:120,exited:true,is_held:true}
]));
if (args[1] === 'new-pane') console.log('terminal_8');
`);
  try {
    assert.equal(await createSurface("sibling"), "terminal_8");
    const split = f.calls().find(c => c.args[1] === "new-pane")!;
    assert.equal(split.parent, "7");
    assert.equal(split.args[split.args.indexOf("--direction") + 1], "right");
    assert.equal(process.env.ZELLIJ_PANE_ID, "0");
  } finally { f.close(); }
});

it("recovers background tabs by marker, never treating an empty reply as tab zero", async () => {
  const f = fixture(`
const markerFile = process.env.TEST_DIR + '/marker';
if (args[1] === 'new-tab') {
  fs.writeFileSync(markerFile, args[args.indexOf('--name') + 1]);
  if (process.env.REPLY === 'failure') process.exit(2);
  if (process.env.REPLY === 'wrong-id') console.log('0');
} else if (args[1] === 'list-panes') {
  if (args.includes('--geometry')) console.log('[{"id":0,"is_plugin":false,"tab_id":0,"pane_rows":5,"pane_columns":10}]');
  else {
    const marker = fs.readFileSync(markerFile, 'utf8');
    console.log(JSON.stringify([
      {id:0,is_plugin:false,tab_id:0,tab_name:'unrelated'},
      {id:20,is_plugin:true,tab_id:10,tab_name:marker},
      ...(process.env.REPLY === 'missing' ? [] : [{id:20,is_plugin:false,tab_id:10,tab_name:marker}]),
    ]));
  }
}
`);
  try {
    for (const mode of ["empty", "failure", "missing", "wrong-id"]) {
      process.env.REPLY = mode;
      if (mode === "empty" || mode === "failure") assert.equal(await createSurface("-worker"), "terminal_20");
      else await assert.rejects(createSurface("-worker"), /not retried to avoid duplicates/);
    }
    const calls = f.calls();
    assert.equal(calls.filter(c => c.args[1] === "new-tab").length, 4, "exactly one mutation per launch, even after failure");
    assert.ok(!calls.some(c => c.args[1] === "new-pane" || c.args[1] === "close-tab-by-id"));
    const renames = calls.filter(c => c.args[1] === "rename-tab");
    assert.equal(renames.length, 2);
    assert.ok(renames.every(c => c.args.includes("10") && c.args.at(-2) === "--"));
    assert.ok(calls.filter(c => c.args[1] === "new-tab").every(c =>
      c.args.includes("--no-focus") && c.args.includes("layout { pane; }")), "do not inherit user startup commands or stacks");
  } finally { f.close(); }
});

it("rejects overflow on 0.44 before creating a tab instead of stealing focus", async () => {
  const f = fixture(`if (args[1] === 'list-panes') console.log('[{"id":0,"is_plugin":false,"tab_id":0,"pane_rows":5,"pane_columns":10}]');`);
  try {
    process.env.TEST_VERSION = "zellij 0.44.3";
    const legacy = await import("../pi-extension/subagents/zellij.ts?legacy-background");
    await assert.rejects(legacy.createSurface("overflow"), /Upgrade to Zellij 0.45/);
    assert.ok(!f.calls().some(c => c.args[1] === "new-tab" || c.args[1] === "new-pane"));
  } finally { f.close(); }
});

it("shares fallback lists, throttles failures, and aborts waiters independently", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') {
  if (process.env.LIST_MODE === 'hang') setTimeout(() => {}, 30000);
  else setTimeout(() => {
    console.log(process.env.LIST_MODE === 'invalid' ? '{}' : '[{"id":7,"is_plugin":false}]');
  }, 150);
}
`);
  try {
    const cancel = new AbortController();
    const a = hooks.queryPaneSample(cancel.signal);
    const b = hooks.queryPaneSample(AbortSignal.timeout(3000));
    cancel.abort();
    await assert.rejects(a, /Aborted/);
    const sample = await b;
    assert.deepEqual([...sample.panes!], ["terminal_7"]);
    assert.strictEqual(await hooks.queryPaneSample(AbortSignal.timeout(3000)), sample);
    assert.equal(f.calls().length, 1);
    hooks.clearPaneSample();
    process.env.LIST_MODE = "invalid";
    const [c, d] = await Promise.all([hooks.queryPaneSample(AbortSignal.timeout(3000)), hooks.queryPaneSample(AbortSignal.timeout(3000))]);
    assert.strictEqual(c, d);
    assert.equal(c.panes, null, "malformed output means unknown, not empty");
    assert.strictEqual(await hooks.queryPaneSample(AbortSignal.timeout(3000)), c);
    assert.equal(f.calls().length, 2);
    hooks.clearPaneSample();
    process.env.LIST_MODE = "hang";
    const start = performance.now();
    await assert.rejects(hooks.queryPaneSample(AbortSignal.timeout(200)), /Aborted/);
    assert.ok(performance.now() - start < 1500);
    delete process.env.LIST_MODE;
    assert.ok((await hooks.queryPaneSample(AbortSignal.timeout(3000))).panes!.has("terminal_7"));
  } finally { f.close(); }
});

it("does not count a cached missing pane twice, and checks completion before fresh absence", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') console.log('[]');
if (args[1] === 'dump-screen' && process.env.COMPLETE === '1') console.log('__SUBAGENT_DONE_0__');
`);
  try {
    let ticks = 0;
    const result = await pollForExit("terminal_7", AbortSignal.timeout(3000), {
      interval: 1,
      onTick() { if (++ticks === 3) process.env.COMPLETE = "1"; },
    });
    assert.equal(ticks, 3, "cached absence must not cause interruption on the second poll");
    assert.equal(result.reason, "sentinel");
    assert.equal(f.calls().filter(c => c.args[1] === "list-panes").length, 1);
  } finally { f.close(); }
});

it("reads scrollback only after PID exit so an off-viewport sentinel is not lost", async () => {
  const f = fixture(`
if (args[1] === 'dump-screen') {
  if (args.includes('--full')) fs.writeFileSync(args[args.indexOf('--path') + 1], 'answer\\n__SUBAGENT_DONE_7__\\nshell prompt');
  else console.log('shell prompt');
}
`);
  const pidFile = join(f.dir, "pid");
  writeFileSync(pidFile, "12345");
  const probe = mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  try {
    assert.deepEqual(await pollForExit("terminal_7", AbortSignal.timeout(3000), { interval: 1, pidFile }), { reason: "sentinel", exitCode: 7 });
    const reads = f.calls().filter(c => c.args[1] === "dump-screen");
    assert.equal(reads.length, 2);
    assert.ok(!reads[0].args.includes("--full"));
    assert.ok(reads[1].args.includes("--full"));
    assert.ok(!f.calls().some(c => c.args[1] === "list-panes"));
  } finally { probe.mock.restore(); f.close(); }
});
