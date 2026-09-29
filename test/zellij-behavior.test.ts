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
  delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_COLUMNS;
  delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_ROWS;
  hooks.clearPaneSample();
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)),
    close() { process.env = env; hooks.clearPaneSample(); rmSync(dir, { recursive: true, force: true }); } };
}

it("serializes tiled placement and sends overflow to background tabs", async () => {
  const f = fixture(`
const stateFile = process.env.TEST_DIR + '/state';
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {count:0};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (args[1] === 'list-panes') {
  if (args.includes('--geometry') && process.env.BAD_LAYOUT === '1') { console.log('{}'); process.exit(); }
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
    assert.ok(tab.args.includes("--no-focus") && tab.args.includes("layout { pane; }"));
    assert.equal(split.parent, "0");
    assert.ok(split.args.includes("--no-focus") && !split.args.includes("--stacked"));
    assert.equal(split.args[split.args.indexOf("--direction") + 1], "right");
    assert.ok(ticks > 10, "CLI waits must not block the parent event loop");
    assert.equal(process.env.ZELLIJ_PANE_ID, "0");
    process.env.BAD_LAYOUT = "1";
    assert.equal(await createSurface("fallback"), "terminal_20");
    assert.equal(f.calls().filter(c => c.args[1] === "new-pane").length, 1,
      "unavailable geometry must never cause an uncontrolled split");
    assert.equal(f.calls().filter(c => c.args[1] === "new-tab").length, 2);
  } finally { clearInterval(timer); f.close(); }
});

it("targets a visible exited sibling explicitly instead of shrinking the larger parent", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') console.log(JSON.stringify([
  {id:0,is_plugin:false,tab_id:9,pane_rows:80,pane_columns:200},
  {id:7,is_plugin:false,tab_id:9,pane_rows:80,pane_columns:120,exited:true,is_held:true}
]));
if (args[1] === 'new-pane') console.log('terminal_8');
`);
  try {
    assert.equal(await createSurface("sibling"), "terminal_8");
    const split = f.calls().find(c => c.args[1] === "new-pane")!;
    assert.equal(split.parent, "7");
    assert.equal(split.args[split.args.indexOf("--direction") + 1], "down");
    assert.equal(process.env.ZELLIJ_PANE_ID, "0");
    assert.ok(split.args.includes("--no-focus"));
    process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_COLUMNS = "1000";
    process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_ROWS = "1000";
    assert.equal(await createSurface("sibling-with-large-parent-minimum"), "terminal_8");
    assert.equal(f.calls().filter(c => c.args[1] === "new-pane").at(-1)!.parent, "7");
  } finally { f.close(); }
});

it("uses background tabs for failed, missing or incomplete layout inspection", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') {
  if (args.includes('--geometry')) {
    if (process.env.LAYOUT_CASE === 'failed') process.exit(1);
    if (process.env.LAYOUT_CASE === 'missing') console.log('[]');
    else console.log(JSON.stringify([
      {id:0,is_plugin:false,tab_id:9,pane_rows:50,pane_columns:180},
      {id:7,is_plugin:false,tab_id:9}
    ]));
  } else console.log(JSON.stringify([{id:20,is_plugin:false,tab_id:10,tab_name:fs.readFileSync(process.env.TEST_DIR+'/marker','utf8')}]));
} else if (args[1] === 'new-tab') {
  fs.writeFileSync(process.env.TEST_DIR+'/marker',args[args.indexOf('--name')+1]); console.log('10');
}
`);
  try {
    for (const mode of ['failed', 'missing', 'incomplete']) {
      process.env.LAYOUT_CASE = mode;
      assert.equal(await createSurface(mode), 'terminal_20');
    }
    assert.ok(!f.calls().some(c => c.args[1] === 'new-pane'));
    assert.equal(f.calls().filter(c => c.args[1] === 'new-tab').length, 3);
  } finally { f.close(); }
});

it("applies parent-specific minimums before deciding to split", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') {
  if (args.includes('--geometry')) console.log('[{"id":0,"is_plugin":false,"tab_id":9,"pane_rows":40,"pane_columns":120}]');
  else console.log(JSON.stringify([{id:20,is_plugin:false,tab_id:10,tab_name:fs.readFileSync(process.env.TEST_DIR+'/marker','utf8')}]));
} else if (args[1] === 'new-tab') {
  fs.writeFileSync(process.env.TEST_DIR+'/marker',args[args.indexOf('--name')+1]); console.log('10');
}
`);
  try {
    process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_COLUMNS = '80';
    process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_ROWS = '20';
    assert.equal(await createSurface('protected'), 'terminal_20');
    assert.ok(!f.calls().some(c => c.args[1] === 'new-pane'));
  } finally { f.close(); }
});

it("recovers a lost background tab reply without creating another tab", async () => {
  const f = fixture(`
if (args[1] === 'list-panes') {
  if (args.includes('--geometry')) console.log('[{"id":0,"is_plugin":false,"tab_id":0,"pane_rows":5,"pane_columns":10}]');
  else console.log(JSON.stringify([{id:20,is_plugin:false,tab_id:10,tab_name:fs.readFileSync(process.env.TEST_DIR+'/marker','utf8')}]));
} else if (args[1] === 'new-tab') {
  fs.writeFileSync(process.env.TEST_DIR+'/marker', args[args.indexOf('--name')+1]);
}
`);
  try {
    assert.equal(await createSurface('recovered'), 'terminal_20');
    assert.equal(f.calls().filter(c => c.args[1] === 'new-tab').length, 1);
  } finally { f.close(); }
});

it("rejects overflow on 0.44 before creating a tab instead of stealing focus", async () => {
  const f = fixture(`if (args[1] === 'list-panes') { if (process.env.FAIL_LAYOUT === '1') process.exit(1); console.log('[{"id":0,"is_plugin":false,"tab_id":0,"pane_rows":5,"pane_columns":10}]'); }`);
  try {
    process.env.TEST_VERSION = "zellij 0.44.3";
    const legacy = await import("../pi-extension/subagents/zellij.ts?legacy-background");
    await assert.rejects(legacy.createSurface("overflow"), /Upgrade to Zellij 0.45/);
    process.env.FAIL_LAYOUT = "1";
    await assert.rejects(legacy.createSurface("unknown-layout"), /Upgrade to Zellij 0.45/);
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
