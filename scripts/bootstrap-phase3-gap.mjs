// Dev tooling: fresh Phase 3 root at GAP_DEFINED from a validated source root.
// Usage: node scripts/bootstrap-phase3-gap.mjs --source <root> --target <root> [--routing-escalation <role>=<reason>]...
import { join, resolve } from "node:path";
import { HARNESS_ROOT } from "../dist/runtime/src/storage.js";
import { bootstrapGapCheckpoint } from "../dist/runtime/dev/gap-checkpoint.js";

const args = process.argv.slice(2);
const read = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const source = read("--source"), target = read("--target");
const escalations = args.flatMap((arg, index) => arg === "--routing-escalation" ? [(args[index + 1] ?? "").split("=")] : []);
if (!source || !target || args.length !== 4 + 2 * escalations.length || escalations.some(pair => pair.length !== 2 || !pair[0] || !pair[1])) {
  process.stderr.write("USAGE: bootstrap-phase3-gap.mjs --source <validated-root> --target <fresh-root> [--routing-escalation <role>=<reason>]...\n");
  process.exit(1);
}
const storage = process.env.CARTERA_HARNESS_STATE ? resolve(process.env.CARTERA_HARNESS_STATE) : join(HARNESS_ROOT, "state");
try {
  const shown = await bootstrapGapCheckpoint({ storage_root: storage, source_root: source, target_root: target, ...(escalations.length ? { routing_escalations: Object.fromEntries(escalations) } : {}) });
  process.stdout.write(JSON.stringify(shown, null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
