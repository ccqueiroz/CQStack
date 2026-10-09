import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventLog, type HarnessVersion } from "./events.js";
import { readHarnessVersion } from "./git.js";
import { BINDING_FILE_NAME, PROFILE_FILE_NAME, ProfileError, loadProfile } from "./profile.js";
import { StateError, assertTrustedPath } from "./storage.js";

export interface BusOptions {
  projectRoot: string | undefined;
  cloneRoot: string;
  homeDir: string;
  cloneTimeoutMs?: number;
}

export interface Bus {
  log: EventLog;
  version: HarnessVersion;
}

const isMissing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

function statOf(path: string, follow = false): Stats | undefined {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

// The deepest existing component is resolved, so a link anywhere on the way is followed and the checks see where it leads.
function resolveReal(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (statOf(current) === undefined) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync.native(current), ...missing);
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

// The profile is read at the real root, which the binding records: join() drops "link/.." as text, while the disk resolves it
// through the link. A root the disk cannot resolve gets the codes the loader gives a profile it cannot read; a root that is not
// an absolute text is left to the loader, which refuses it.
function realRoot(projectRoot: string | undefined): string {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) return projectRoot as string;
  try {
    return realpathSync.native(projectRoot);
  } catch (error) {
    const file = join(projectRoot, PROFILE_FILE_NAME);
    if (isMissing(error)) throw new ProfileError("PROFILE_NOT_FOUND", `Profile not found: ${file}`);
    throw new ProfileError("PROFILE_UNREADABLE", `Profile could not be read: ${file} (${(error as NodeJS.ErrnoException).code})`);
  }
}

// Checks everything before anything is written: profile, clone version, then every path (real paths, so a trailing slash,
// a link or /tmp -> /private/tmp never makes another place).
export async function createBus(options: BusOptions): Promise<Bus> {
  const { projectRoot, cloneRoot, homeDir } = options ?? ({} as Partial<BusOptions>);
  const root = realRoot(projectRoot);
  const profile = loadProfile(root);
  const version = await readHarnessVersion(cloneRoot as string);
  if (typeof homeDir !== "string" || !isAbsolute(homeDir) || statOf(homeDir, true)?.isDirectory() !== true)
    throw new StateError("HOME_INVALID", `Home folder must be an existing absolute folder: ${String(homeDir)}`);
  const home = realpathSync.native(homeDir);
  const clone = realpathSync.native(cloneRoot);
  const area = join(home, ".cqstack", "projects", profile.project_id);
  const stateDir = resolve(area, profile.state_dir ?? "state");
  const bindingFile = join(area, BINDING_FILE_NAME);
  const store = profile.knowledge_store.path === undefined ? area : resolveReal(join(root, profile.knowledge_store.path));
  for (const [label, path] of [["Local area", area], ["Memory store", store]])
    if (isInside(path, clone))
      throw new StateError("PATH_INSIDE_HARNESS", `${label} must not be the harness clone or inside it: ${path} (clone: ${clone})`);
  if (store !== area && (isInside(store, area) || isInside(area, store)))
    throw new StateError("STORE_PATH_INVALID", `Memory store must not be inside the local area or contain it: ${store}`);
  assertTrustedPath(stateDir);
  assertTrustedPath(bindingFile);
  // the loader keeps stateDir inside the area; the root check only stops the walk if that ever breaks
  for (let current = stateDir; current !== home && current !== dirname(current); current = dirname(current))
    if (statOf(current)?.isDirectory() === false)
      throw new StateError("STATE_DIR_INVALID", `State directory or a folder above it is not a folder: ${current}`);
  return { log: new EventLog(stateDir, profile, version), version };
}
