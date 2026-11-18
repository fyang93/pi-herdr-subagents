/** Optional presentation for the herdr-core backend.
 * Every child gets a dedicated background tab in its parent's space. The app's
 * documented label adoption preserves focus. No placeholder shells, layout-file
 * writes, pane dimension guesses or focus/restore races.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export type CoreCall = (method: string, params: Record<string, unknown>) => Promise<any>;
type AppCall = (args: string[]) => Promise<any>;
export interface AppSnapshot {
  spaces: { id: string; machine?: string | null; tabs: { id: string; terminals: { terminal: string }[] }[] }[];
}

export async function appCall(args: string[]): Promise<any> {
  const { stdout } = await exec(process.env.HERDR_APP_BIN_PATH || "herdr-app", args, {
    encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (result?.error) throw new Error(`herdr-app: ${result.error}`);
  return result;
}

/** Never target whichever space happens to be focused. */
export function parentAppSpace(snapshot: AppSnapshot, parent: string): string | undefined {
  return snapshot.spaces.find(s => !s.machine && s.tabs.some(t => t.terminals.some(p => p.terminal === parent)))?.id;
}

export async function presentCoreTerminal(
  terminal: string, parent: string, name: string, core: CoreCall,
  options: { app?: AppCall; timeout?: number } = {},
): Promise<void> {
  if (process.env.PI_SUBAGENT_APP_LAYOUT === "hidden") return;
  const app = options.app ?? appCall;
  // The core record's official app labels also work without the app CLI on PATH
  // (e.g. a macOS bundle). The app can adopt the child when next opened.
  const record = await core("terminal.get", { terminal: parent });
  let space = record.labels?.["herdr.space"];
  if (typeof space !== "string" || !space) return; // Headless core; never attach to an unrelated app.
  let appReachable = false;
  try {
    const snapshot: AppSnapshot = await app(["ls"]);
    if (Array.isArray(snapshot?.spaces)) {
      appReachable = true;
      // A successful ls not containing the parent may be a different window/core.
      // Do not change that window, even if inherited labels name a space in it.
      space = parentAppSpace(snapshot, parent);
    }
  } catch { /* No window/CLI: use persisted labels, never start or raise the app. */ }
  if (typeof space !== "string" || !space) return;
  const tab = `tb${randomUUID().replaceAll("-", "")}`;
  await core("terminal.label", { terminal, labels: { "herdr.space": space, "herdr.tab": tab } });
  if (!appReachable) return;
  // Observe adoption before naming the new tab; never repeat the mutation. Each
  // child has its own ID, so concurrent launches do not contend over layout.
  const until = Date.now() + (options.timeout ?? 2500);
  while (Date.now() < until) {
    const current: AppSnapshot = await app(["ls"]);
    const adopted = current.spaces?.some(s => s.tabs.some(t => t.id === tab && t.terminals.some(p => p.terminal === terminal)));
    if (adopted) {
      // App adoption enables keep by default. Autonomous children must not turn
      // into replacement shells after a crash, leaving the parent waiting forever.
      await core("terminal.keep", { terminal, keep: false });
      await app(["do", "tab.rename", JSON.stringify({ id: tab, name })]);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  console.warn(`herdr-app has not yet shown subagent ${terminal}; it remains running in herdr-core.`);
}
