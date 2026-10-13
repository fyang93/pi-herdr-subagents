// Imported first by the tests: the extension reads its environment at import, and no test
// may reach the real herdr server or inherit the permissions of a subagent running the tests.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_") || key.startsWith("HERDR_")) delete process.env[key];
}
// A herdr with no agents and its pi integration installed, which answers every other call
// with an empty result.
const shim = mkdtempSync(join(tmpdir(), "herdr-shim-"));
const herdr = join(shim, "herdr");
const integration = join(shim, "herdr-agent-state.ts");
writeFileSync(integration, "export default () => {};\n");
writeFileSync(herdr, `#!/bin/sh
if [ "$1 $2" = "agent get" ]; then echo '{"error":{"code":"agent_not_found","message":"no agents"}}' >&2; exit 1; fi
if [ "$1 $2" = "integration status" ]; then echo 'pi: current (v9) (${integration})'; exit 0; fi
echo '{"result":{}}'
`);
chmodSync(herdr, 0o755);
process.env.HERDR_BIN_PATH = herdr;
