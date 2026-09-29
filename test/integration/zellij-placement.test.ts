// No LLM calls; uses only a temporary background tab on Zellij 0.45+.
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSurface, isZellijAvailable } from "../../pi-extension/subagents/zellij.ts";

for (const held of [false, true]) {
it(`Zellij: splitting a ${held ? "exited/held" : "live"} sibling preserves the original parent's geometry`, {
  skip: !isZellijAvailable(), timeout: 30_000,
}, async () => {
  const env = { ...process.env };
  const action = (...args: string[]) => execFileSync("zellij", ["action", ...args], { encoding: "utf8" });
  const panes = () => JSON.parse(action("list-panes", "--json", "--all"));
  const name = `pi-placement-test-${process.pid}-${Date.now()}`;
  let tabId: number | undefined;
  const geometry = (p: any) => [p.pane_x, p.pane_y, p.pane_columns, p.pane_rows];
  const activeTabs = () => JSON.parse(action("list-tabs", "--json")).filter((t: any) => t.active).map((t: any) => t.tab_id);
  const activeBefore = activeTabs();
  try {
    const reply = action("new-tab", "--no-focus", "--name", name, "--layout-string", "layout { pane; }").trim();
    assert.match(reply, /^\d+$/);
    assert.ok(Number.isSafeInteger(Number(reply)));
    tabId = Number(reply);
    let parent: any;
    for (let i = 0; i < 40 && !parent; i++) {
      parent = panes().find((p: any) => p.tab_id === tabId && !p.is_plugin);
      if (!parent) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(parent);
    process.env.ZELLIJ_PANE_ID = String(parent.id);
    delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_COLUMNS;
    delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_ROWS;
    // Permit exactly two columns of panes, then require splitting vertically.
    process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = String(Math.floor(parent.pane_columns / 2) - 2);
    process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = String(Math.floor(parent.pane_rows / 4));
    // Explicit commands remain held after exit, just like completed automation panes.
    const first = held
      ? action("new-pane", "--no-focus", "--direction", "right", "--name", "placement-held",
        "--", "sh", "-c", "exit 0").trim()
      : await createSurface("placement-first");
    const find = (id: number) => panes().find((p: any) => !p.is_plugin && p.id === id);
    const before = find(parent.id);
    const siblingId = Number(first.replace("terminal_", ""));
    if (held) {
      for (let i = 0; i < 40 && !find(siblingId)?.exited; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(find(siblingId)?.exited, true, "reproduce a visible exited terminal");
    }
    const sibling = find(siblingId);
    assert.equal(sibling.tab_id, tabId);
    assert.ok(sibling.pane_x > before.pane_x, "first child is to the right");
    const second = await createSurface("placement-second");
    const after = find(parent.id);
    const child = find(Number(second.replace("terminal_", "")));
    assert.deepEqual(geometry(after), geometry(before), "second child must not shrink parent");
    assert.equal(child.tab_id, tabId);
    for (const p of [after, child, find(siblingId)]) {
      assert.ok(p.pane_content_columns >= Number(process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS));
      assert.ok(p.pane_content_rows >= Number(process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS));
      assert.ok(p.pane_columns <= after.pane_columns && p.pane_rows <= after.pane_rows);
    }
    assert.equal(child.pane_x, sibling.pane_x, "second child splits the sibling column");
    assert.ok(find(siblingId), "keep the sibling and its output, even after exit");
    assert.deepEqual(activeTabs(), activeBefore, "background creation must preserve active tabs");
    const third = await createSurface("placement-third");
    const balancedParent = find(parent.id);
    assert.equal(balancedParent.pane_rows, before.pane_rows / 2, "split the half-screen parent into quarters");
    for (const id of [siblingId, Number(second.replace("terminal_", "")), Number(third.replace("terminal_", ""))]) {
      const p = find(id);
      assert.equal(p.pane_columns, balancedParent.pane_columns);
      assert.equal(p.pane_rows, balancedParent.pane_rows);
    }
    process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = "10000";
    const overflow = await createSurface(`${name}-overflow`);
    assert.notEqual(find(Number(overflow.replace("terminal_", ""))).tab_id, tabId);
    assert.deepEqual(geometry(find(parent.id)), geometry(balancedParent));
    assert.deepEqual(activeTabs(), activeBefore, "overflow also preserves active tabs");
  } finally {
    process.env = env;
    // Clean up only the uniquely named test tab, never an unrelated ID.
    const tabs = JSON.parse(action("list-tabs", "--json")).filter((t: any) =>
      t.name === name || t.name === `${name}-overflow`);
    for (const tab of tabs) action("close-tab-by-id", String(tab.tab_id));
  }
});
}

it("Zellij: repeated splits keep every child in the parent's tab no larger than the parent", {
  skip: !isZellijAvailable(), timeout: 30_000,
}, async (t) => {
  const env = { ...process.env };
  const action = (...args: string[]) => execFileSync("zellij", ["action", ...args], { encoding: "utf8" });
  const panes = () => JSON.parse(action("list-panes", "--json", "--all"));
  const name = `pi-multi-placement-${process.pid}-${Date.now()}`;
  const tabs = () => JSON.parse(action("list-tabs", "--json"));
  const activeBefore = tabs().filter((t: any) => t.active).map((t: any) => t.tab_id);
  try {
    const tabId = Number(action("new-tab", "--no-focus", "--name", name).trim());
    let parent: any;
    for (let i = 0; i < 40 && !parent; i++) {
      parent = panes().find((p: any) => p.tab_id === tabId && !p.is_plugin);
      if (!parent) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(parent);
    process.env.ZELLIJ_PANE_ID = String(parent.id);
    delete process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS;
    delete process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS;
    delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_COLUMNS;
    delete process.env.PI_SUBAGENT_ZELLIJ_PARENT_MIN_ROWS;
    let tiled = 0, overflow = 0;
    for (let i = 0; i < 18; i++) {
      const surface = await createSurface(`${name}-${i}`);
      const all = panes();
      const main = all.find((p: any) => p.id === parent.id && !p.is_plugin);
      const child = all.find((p: any) => p.id === Number(surface.replace("terminal_", "")) && !p.is_plugin);
      assert.ok(child, `split ${i + 1} has a terminal`);
      if (child.tab_id === tabId) {
        tiled++;
        for (const p of all.filter((p: any) => p.tab_id === tabId && !p.is_plugin)) {
          assert.ok(p.pane_columns <= main.pane_columns && p.pane_rows <= main.pane_rows,
            `split ${i + 1}: ${p.id} ${p.pane_columns}x${p.pane_rows} exceeds main ${main.pane_columns}x${main.pane_rows}`);
        }
      } else {
        overflow++;
        assert.equal(all.filter((p: any) => p.tab_id === child.tab_id && !p.is_plugin).length, 1);
        for (const plugin of ["tab-bar", "status-bar"]) {
          assert.ok(all.some((p: any) => p.tab_id === child.tab_id && p.plugin_url === plugin));
        }
      }
      assert.deepEqual(tabs().filter((t: any) => t.active).map((t: any) => t.tab_id), activeBefore);
    }
    assert.ok(tiled >= 6 && overflow >= 1, `expected multiple tiled splits and overflow; got ${tiled} and ${overflow}`);
    t.diagnostic(`${tiled} tiled panes, ${overflow} background tabs; parent remains largest in its tab`);
  } finally {
    process.env = env;
    for (const tab of tabs().filter((t: any) => t.name === name || t.name.startsWith(`${name}-`))) {
      action("close-tab-by-id", String(tab.tab_id));
    }
  }
});
