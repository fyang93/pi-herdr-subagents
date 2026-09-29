// No LLM calls. Run inside Zellij 0.44+: node --test test/integration/zellij-surface.test.ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isZellijAvailable, createSurface,
  sendCommand, sendLongCommand, readScreen, readScreenAsync, closeSurface, pollForExit, shellEscape,
} from "../../pi-extension/subagents/zellij.ts";

it("Zellij: size-bounded tiled placement, overflow rejection, messages and exit detection", {
  skip: !isZellijAvailable(), timeout: 30_000,
}, async () => {
  const action = (...args: string[]) => execFileSync("zellij", ["action", ...args], { encoding: "utf8" });
  const panes = () => JSON.parse(action("list-panes", "--json", "--all"));
  const name = `pi-test-${process.pid}-${Date.now()}`;
  const oldParent = process.env.ZELLIJ_PANE_ID;
  const oldColumns = process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS;
  const oldRows = process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS;
  const dir = mkdtempSync(join(tmpdir(), "pi-zellij-test-"));
  let tabId: number | undefined;
  try {
    action("new-tab", "--name", name, "--layout", "default");
    let parent: any;
    for (let i = 0; i < 40 && !parent; i++) {
      parent = panes().find((p: any) => p.tab_name === name && !p.is_plugin);
      if (!parent) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(parent);
    tabId = parent.tab_id;
    process.env.ZELLIJ_PANE_ID = String(parent.id);
    assert.ok(isZellijAvailable());

    const activeTabs = () => JSON.parse(action("list-tabs", "--json")).filter((t: any) => t.active).map((t: any) => t.tab_id);
    const activeBefore = activeTabs();
    // Exercise both paths independently of the test terminal's dimensions.
    process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = "1";
    process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = "1";
    const first = await createSurface("first");
    const children = [first, ...await Promise.all([createSurface("second"),
      createSurface("third", `terminal_${parent.id}`)])];
    process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = "10000";
    process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = "10000";
    await assert.rejects(createSurface("overflow"), /No safe tiled split/);
    const childPanes = children.map(surface => panes().find((p: any) => !p.is_plugin && p.id === Number(surface.replace("terminal_", ""))));
    assert.ok(childPanes.every((p: any) => p), "each pane should exist");
    const main = panes().find((p: any) => !p.is_plugin && p.id === parent.id);
    assert.ok(childPanes.every((p: any) => p.tab_id === tabId &&
      p.pane_columns <= main.pane_columns && p.pane_rows <= main.pane_rows));
    assert.deepEqual(activeTabs(), activeBefore, "do not switch the active tab");
    assert.ok(childPanes.every((p: any) => !p.is_suppressed), "subagent panes remain visible, never stacked");
    const focused = () => panes().filter((p: any) => p.tab_id === tabId && !p.is_plugin && p.is_focused).map((p: any) => p.id);
    assert.deepEqual(focused(), [parent.id], "new panes do not steal client focus");
    assert.equal(panes().filter((p: any) => p.tab_id === tabId && !p.is_plugin).length, 4);
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS ?? 2500)));

    const literal = "$HOME 'quoted' " + "X".repeat(500);
    sendLongCommand(children[1], `printf '%s\\n' ${shellEscape(literal)}; printf '__SUBAGENT_DONE_%s__\\n' 7`, {
      scriptPath: join(dir, "launch.sh"),
    });
    assert.deepEqual(await pollForExit(children[1], AbortSignal.timeout(10_000), { interval: 50 }), {
      reason: "sentinel", exitCode: 7,
    });
    const syncScreen = readScreen(children[1], 50);
    const asyncScreen = await readScreenAsync(children[1], 50);
    // Zellij may insert a newline where scrollback meets the viewport, even
    // inside a soft-wrapped line. Verify the full payload across that boundary.
    assert.ok(syncScreen.replaceAll("\n", "").includes(literal), JSON.stringify(syncScreen));
    assert.ok(asyncScreen.replaceAll("\n", "").includes(literal), JSON.stringify(asyncScreen));
    sendCommand(children[2], "printf 'MESSAGE_%s_END\\n' delivered");
    for (let i = 0; i < 100 && !readScreen(children[2]).includes("MESSAGE_delivered_END"); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(readScreen(children[2]).includes("MESSAGE_delivered_END"));
    assert.ok(!readScreen(children[0]).includes("MESSAGE_delivered_END"));
    assert.deepEqual(focused(), [parent.id]);
    closeSurface(children[2]);
    closeSurface(children[1]);
    closeSurface(children[0]);
    assert.equal(panes().filter((p: any) => p.tab_id === tabId && !p.is_plugin).length, 1, "only the parent remains in its original tab");
  } finally {
    if (oldColumns === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS;
    else process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = oldColumns;
    if (oldRows === undefined) delete process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS;
    else process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = oldRows;
    if (oldParent === undefined) delete process.env.ZELLIJ_PANE_ID;
    else process.env.ZELLIJ_PANE_ID = oldParent;
    if (tabId !== undefined) action("close-tab-by-id", String(tabId));
    rmSync(dir, { recursive: true, force: true });
  }
});
