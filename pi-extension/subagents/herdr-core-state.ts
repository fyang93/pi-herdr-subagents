/** Loaded explicitly into Pi children. Keep the terminal's session identity current
 * across /new, /resume and /fork, so parent recovery cannot adopt a different session.
 * Pi itself already emits herdr-core's native OSC 7501 status reports.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { coreRequest, isCoreAvailable } from "./herdr-core.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!isCoreAvailable()) return;
    const session = ctx.sessionManager.getSessionFile();
    await coreRequest("terminal.label", {
      terminal: process.env.HC_TERMINAL_ID,
      labels: { "pi.subagent.session": session ? resolve(session) : "" },
    });
  });
}
