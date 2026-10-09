import { Ajv } from "ajv";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventLog, type HarnessVersion } from "./events.js";
import { readHarnessVersion, runGit } from "./git.js";
import { BINDING_FILE_NAME, PROFILE_FILE_NAME, ProfileError, loadProfile, type ProjectProfile } from "./profile.js";
import { ID_PATTERN, StateError, assertTrustedPath, canonicalHash, readText, syncFolder } from "./storage.js";

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

export interface ProjectBinding {
  project_id: string;
  project_root: string;
  profile_path: string;
  profile_hash: string;
  created_at: string;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateBinding = ajv.compile<ProjectBinding>({
  type: "object",
  properties: {
    project_id: { type: "string", pattern: ID_PATTERN.source },
    project_root: { type: "string" },
    profile_path: { type: "string" },
    profile_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    created_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
  },
  required: ["project_id", "project_root", "profile_path", "profile_hash", "created_at"],
  additionalProperties: false,
});

// The environment of git in the memory store: the user's own git and ssh configuration (credential helper, keys, agent), and
// never a prompt, since the session has no terminal for it.
// ponytail: GIT_SSH_COMMAND replaces the user's core.sshCommand; honor it when a setup needs it.
export function storeGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    ...(process.env.SSH_AUTH_SOCK === undefined ? {} : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  };
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

// The top folder of a git repository, with its exclude file. A folder inside another repository (the user's project, a versioned
// home) is not one: --show-toplevel answers with the repository above it. A linked worktree or a .git file keeps the git folder
// elsewhere, and one in the harness clone would put the memory and the exclude line there.
async function repositoryAt(folder: string, clone: string): Promise<{ excludeFile: string } | "absent" | "not a repository"> {
  try {
    if (!lstatSync(folder).isDirectory()) return "not a repository";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return "not a repository";
    throw error;
  }
  let gitFolder: string, excludeFile: string;
  try {
    let top: string;
    [top, gitFolder, excludeFile] = (await runGit(folder, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-path", "info/exclude"])).split("\n");
    if (realpathSync.native(top) !== folder) return "not a repository";
  } catch {
    return "not a repository";
  }
  excludeFile = resolve(folder, excludeFile);
  for (const path of [gitFolder, excludeFile])
    if (isInside(resolveReal(path), clone))
      throw new StateError("PATH_INSIDE_HARNESS", `Git folder of ${folder} must not be the harness clone or inside it: ${path} (clone: ${clone})`);
  return { excludeFile };
}

const notRepository = (folder: string) =>
  new StateError("STORE_NOT_GIT", `Memory store exists and is not the top folder of a git repository: ${folder}`);

// A repository made in a temporary folder beside its target and renamed into place, so a crash never leaves a target that
// looks like a store.
interface Prepared {
  target: string;
  temporary: string;
  firstCreated: string | undefined;
}

async function prepareRepository(target: string, home: string): Promise<Prepared> {
  const firstCreated = mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const prepared = { target, temporary: mkdtempSync(join(dirname(target), `.${basename(target)}.partial-`)), firstCreated };
  const { temporary } = prepared;
  try {
    // no template: no hooks and no sample files from this machine in the memory
    await runGit(dirname(target), ["init", "--quiet", "--template=", "--", temporary], { env: storeGitEnv(home) });
  } catch (error) {
    discard(prepared);
    throw error;
  }
  return prepared;
}

// Nothing once the temporary folder is in place; otherwise it goes, with the parents made for it.
function discard(prepared: Prepared | undefined): void {
  if (prepared === undefined || statOf(prepared.temporary) === undefined) return;
  rmSync(prepared.temporary, { recursive: true, force: true });
  if (prepared.firstCreated !== undefined) rmSync(prepared.firstCreated, { recursive: true, force: true });
}

function ensureExcluded(excludeFile: string, line: string): void {
  let text = "";
  try {
    text = readFileSync(excludeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text.split("\n").includes(line)) return;
  mkdirSync(dirname(excludeFile), { recursive: true, mode: 0o700 });
  appendFileSync(excludeFile, (text === "" || text.endsWith("\n") ? "" : "\n") + line + "\n");
}

function writeBindingFile(file: string, binding: ProjectBinding): void {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(binding, null, 2) + "\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Linked into an area that exists, never renamed over: an existing binding is never replaced. The file is written in a
// temporary folder beside the area, outside its git, and the folder goes either way.
function linkBinding(area: string, binding: ProjectBinding): void {
  const temporary = mkdtempSync(join(dirname(area), `.${basename(area)}.partial-`));
  try {
    writeBindingFile(join(temporary, BINDING_FILE_NAME), binding);
    linkSync(join(temporary, BINDING_FILE_NAME), join(area, BINDING_FILE_NAME));
    syncFolder(area);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// A binding found on disk is read, never rewritten: a refusal leaves it for the user to fix.
function readBinding(file: string, profile: ProjectProfile): ProjectBinding {
  const invalid = (reason: string) => new StateError("BINDING_INVALID", `Project binding is not valid: ${file}: ${reason}`);
  let binding: unknown;
  try {
    binding = JSON.parse(readText(file));
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw invalid((error as Error).message);
  }
  if (!validateBinding(binding)) throw invalid(ajv.errorsText(validateBinding.errors));
  if (binding.project_id !== profile.project_id) throw invalid(`project_id is not ${profile.project_id}, the one of the profile`);
  if (resolve(binding.project_root) !== binding.project_root) throw invalid("project_root is not an absolute, normalized path");
  if (binding.profile_path !== join(binding.project_root, PROFILE_FILE_NAME)) throw invalid("profile_path is not the profile of project_root");
  return binding;
}

function assertBoundTo(binding: ProjectBinding, root: string, file: string): void {
  if (binding.project_root !== root)
    throw new StateError(
      "BINDING_ROOT_MISMATCH",
      `Project ${binding.project_id} is bound to another root: ${binding.project_root} (received ${root}); edit or remove ${file} to bind it again`,
    );
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
  // a .gitignore already in the state folder (a crash between creating and writing it leaves it empty) must still keep the whole
  // folder out of git
  const stateIgnore = join(stateDir, ".gitignore");
  const ignoreStats = statOf(stateIgnore);
  if (ignoreStats !== undefined && (!ignoreStats.isFile() || readText(stateIgnore) !== "*\n"))
    throw new StateError("STORE_TRACKS_LOCAL_FILES", `State folder .gitignore must be a file of "*", which keeps the folder out of git: ${stateIgnore}`);
  const bound = statOf(bindingFile) !== undefined;
  if (bound) assertBoundTo(readBinding(bindingFile, profile), root, bindingFile);
  const storeRepository = await repositoryAt(store, clone);
  if (storeRepository === "not a repository") throw notRepository(store);
  // an existing area that is not the store is checked too and gets the exclude line; one without git is used as it is
  let areaRepository = store === area ? storeRepository : await repositoryAt(area, clone);

  // only from here on is anything written. The repositories are made in temporary folders, and the binding claims the area
  // (inside the area put in place, or linked into one that exists) before the store is put in place or the state folder is made
  const binding: ProjectBinding = {
    project_id: profile.project_id,
    project_root: root,
    profile_path: join(root, PROFILE_FILE_NAME),
    profile_hash: canonicalHash(profile),
    created_at: new Date().toISOString(),
  };
  let storeMade: Prepared | undefined;
  let areaMade: Prepared | undefined;
  try {
    if (store !== area && storeRepository === "absent") storeMade = await prepareRepository(store, home);
    if (areaRepository === "absent") {
      areaMade = await prepareRepository(area, home);
      ensureExcluded(join(areaMade.temporary, ".git", "info", "exclude"), `/${BINDING_FILE_NAME}`);
      writeBindingFile(join(areaMade.temporary, BINDING_FILE_NAME), binding);
      renameSync(areaMade.temporary, area);
      // made here by git init or git clone, so its git folder is .git: git is not asked again once the area is in place
      areaRepository = { excludeFile: join(area, ".git", "info", "exclude") };
    } else if (!bound) linkBinding(area, binding);
    if (typeof areaRepository === "object") ensureExcluded(areaRepository.excludeFile, `/${BINDING_FILE_NAME}`);
    if (storeMade !== undefined) renameSync(storeMade.temporary, store);
  } finally {
    discard(storeMade);
    discard(areaMade);
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    // "*" keeps the whole state folder, this file included, out of the git of the area wherever state_dir puts it
    writeFileSync(join(stateDir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { log: new EventLog(stateDir, profile, version), version };
}
