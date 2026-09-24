import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const ENGINEERING_TEST_PREFIX = "engineering-test-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Legacy residues without a pid never match, so an interrupted run of an older suite is left for the operator.
export function sweepDeadTestResidues(stateDirectory: string, prefix = ENGINEERING_TEST_PREFIX): string[] {
  if (!existsSync(stateDirectory)) return [];
  const pattern = new RegExp(`^${prefix}(\\d+)-`);
  const removed: string[] = [];
  for (const name of readdirSync(stateDirectory)) {
    const match = pattern.exec(name);
    if (!match || alive(Number(match[1]))) continue;
    rmSync(join(stateDirectory, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
