import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { HarnessVersion } from "./events.js";
import { StateError } from "./storage.js";

const execFileAsync = promisify(execFile);

// No shell, a minimal explicit env (without HOME, git skips the user's global config), a mandatory timeout and an
// output ceiling; exit != 0, timeout or output over the ceiling reject (decision 48).
// ponytail: execFile stands in for runProcess until F1.1; without a process group a grandchild of git would outlive
// the timeout. F1.1 moves this helper onto runProcess with the same signature.
export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
    maxBuffer: 1_048_576,
    encoding: "utf8",
  });
  return stdout;
}

export async function readHarnessVersion(cloneRoot: string): Promise<HarnessVersion> {
  if (typeof cloneRoot !== "string" || !isAbsolute(cloneRoot))
    throw new StateError("HARNESS_VERSION_UNAVAILABLE", `Harness version could not be read from ${String(cloneRoot)}: not an absolute path`);
  try {
    const commit = (await runGit(cloneRoot, ["rev-parse", "HEAD"])).trim();
    // tags of the commit just read, not of HEAD again: a checkout between the two calls would pair another commit's tag;
    // with several tags on the commit, git lists them by name, so the first one is stable
    const first = (await runGit(cloneRoot, ["tag", "--points-at", commit])).split("\n")[0];
    return { tag: first === "" ? null : first, commit };
  } catch (error) {
    throw new StateError("HARNESS_VERSION_UNAVAILABLE", `Harness version could not be read from ${cloneRoot}: ${(error as Error).message}`);
  }
}
