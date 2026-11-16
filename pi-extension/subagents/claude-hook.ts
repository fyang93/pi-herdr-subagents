/**
 * Claude Code hook for a Claude subagent: hands its final answer to the parent as the
 * `.exit` marker a pi subagent writes. `stop auto <base>` ends an autonomous run at its
 * first Stop; an interactive one (`stop keep <base>`) keeps its latest answer until
 * `end keep <base>`, when the user leaves Claude. Stop does not fire when someone
 * interrupts a turn, which leaves the run open.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const [event, mode, base] = process.argv.slice(2);
const answer = `${base}.answer`;
const write = (file: string, marker: object) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(marker), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
if (event === "stop") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  write(mode === "auto" ? `${base}.exit` : answer, { type: "done", summary: input.last_assistant_message ?? "" });
} else if (event === "end") {
  if (existsSync(answer)) renameSync(answer, `${base}.exit`);
  else write(`${base}.exit`, { type: "done" });
}
