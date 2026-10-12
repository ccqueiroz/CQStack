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
  rmdirSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EventLog, type HarnessVersion } from "./events.js";
import { readHarnessVersion, runGit } from "./git.js";
import { redact } from "./observation.js";
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

// Only https and ssh, even when the user's configuration allows ext or fd: -c on the command line wins over every config file.
// A transport the user allows by name (protocol.<name>.allow) still passes protocol.allow=never; that configuration is trusted.
const PROTOCOL_FLAGS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.fd.allow=never",
];
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

// A credential in a URL of git's output (a rewrite in the user's own configuration can put one there) goes first, up to the
// last "@" of the authority, then the redaction of the observation cuts at the first secret word; the cut to 2000 characters
// comes last, so it never splits a credential away from its pattern.
function cloneFailure(error: unknown, timeoutMs: number): string {
  const { killed, stderr } = error as { killed?: boolean; stderr?: unknown };
  if (killed === true) return `timed out after ${timeoutMs} ms`;
  return redact(String(stderr ?? "").replace(URL_CREDENTIAL, "$1[REDACTED]@")).slice(0, 2000);
}

// project.json and the state folder live in the local area and must stay out of its git: a store that is the area and tracks
// them (or a file where the state folder goes) would show them in git, and a tracked project.json would bring another machine's
// root. A .gitignore of the memory that un-ignores project.json ("!project.json", "!*.json") would win over .git/info/exclude;
// the state folder needs no such check, since its own .gitignore of "*" is the deepest one and wins over any pattern above it.
// Paths are compared without case, as a disk without case reads them: there a tracked "State/x" is in the state folder.
async function assertLocalFilesOutOfGit(folder: string, stateRel: string, store: string): Promise<void> {
  const local = stateRel.toLowerCase();
  const prefixes = local.split("/").map((_, index, segments) => segments.slice(0, index + 1).join("/"));
  const pathspecs = [BINDING_FILE_NAME, ...prefixes].map((path) => `:(literal,icase)${path}`);
  const tracked = (await runGit(folder, ["ls-files", "-z", "--", ...pathspecs])).toLowerCase().split("\0");
  // exit 1 is "no pattern matches project.json"; the matching pattern comes back as <source>:<line>:<pattern><TAB><path>
  const matched = await runGit(folder, ["check-ignore", "--verbose", "--non-matching", "--", BINDING_FILE_NAME]).catch((error: { code?: unknown }) => {
    if (error.code === 1) return "";
    throw error;
  });
  const unignored = matched.split("\t")[0].split(":").slice(2).join(":").startsWith("!");
  if (unignored || tracked.some((path) => path === BINDING_FILE_NAME || path === local || path.startsWith(local + "/") || local.startsWith(path + "/")))
    throw new StateError(
      "STORE_TRACKS_LOCAL_FILES",
      `Memory store tracks or un-ignores project.json or the state folder, which must stay out of its git: ${store}`,
    );
}

const notRepository = (folder: string) =>
  new StateError("STORE_NOT_GIT", `Memory store exists and is not the top folder of a git repository: ${folder}`);

// A repository made in a temporary folder beside its target and renamed into place, so a failed or interrupted clone never
// leaves a target that looks like a store. stateRel is given when the target is the local area, whose clone must not track
// the local files.
interface Prepared {
  target: string;
  temporary: string;
  firstCreated: string | undefined;
}

async function prepareRepository(target: string, home: string, clone?: { remote: string; timeoutMs: number; stateRel?: string }): Promise<Prepared> {
  const firstCreated = mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const prepared = { target, temporary: mkdtempSync(join(dirname(target), `.${basename(target)}.partial-`)), firstCreated };
  const { temporary } = prepared;
  try {
    // no template: no hooks and no sample files from this machine in the memory
    if (clone === undefined)
      await runGit(dirname(target), ["init", "--quiet", "--template=", "--", temporary], { env: storeGitEnv(home) });
    else {
      await runGit(dirname(target), [...PROTOCOL_FLAGS, "clone", "--quiet", "--template=", "--", clone.remote, temporary], {
        env: storeGitEnv(home),
        timeoutMs: clone.timeoutMs,
      }).catch((error: unknown) => {
        throw new StateError("STORE_CLONE_FAILED", `Memory remote could not be cloned into ${target}: ${cloneFailure(error, clone.timeoutMs)}`);
      });
      if (clone.stateRel !== undefined) await assertLocalFilesOutOfGit(temporary, clone.stateRel, target);
    }
  } catch (error) {
    discard(prepared);
    throw error;
  }
  return prepared;
}

// false when another boot put the target in place first
function publish(prepared: Prepared): boolean {
  try {
    renameSync(prepared.temporary, prepared.target);
    return true;
  } catch (error) {
    if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

// Nothing once the temporary folder is in place. Otherwise it goes, and the parents made for it go only while empty: a boot
// running at the same time may already keep its store in them.
function discard(prepared: Prepared | undefined): void {
  if (prepared === undefined || statOf(prepared.temporary) === undefined) return;
  rmSync(prepared.temporary, { recursive: true, force: true });
  for (let folder = dirname(prepared.target); prepared.firstCreated !== undefined; folder = dirname(folder)) {
    try {
      rmdirSync(folder);
    } catch {
      break;
    }
    if (folder === prepared.firstCreated) break;
  }
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

function writeNewFile(file: string, text: string): void {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Linked into place whole, never renamed over: a file already there is never replaced, and false means another boot linked
// first. The file is written in a temporary folder beside the area, outside its git, and the folder goes either way: a boot
// killed while it writes leaves only that folder.
function linkNewFile(area: string, file: string, text: string): boolean {
  const temporary = mkdtempSync(join(dirname(area), `.${basename(area)}.partial-`));
  const written = join(temporary, basename(file));
  try {
    writeNewFile(written, text);
    try {
      linkSync(written, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    syncFolder(dirname(file));
    return true;
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

// No link and no folder open to others on the way to the state folder and the binding, no file where a folder goes, and a
// .gitignore already in the state folder that keeps the whole folder out of git: the boot links only a whole one, but one put
// there by hand may not.
function assertStatePath(stateDir: string, bindingFile: string, home: string): void {
  assertTrustedPath(stateDir);
  assertTrustedPath(bindingFile);
  // the loader keeps stateDir inside the area; the root check only stops the walk if that ever breaks
  for (let current = stateDir; current !== home && current !== dirname(current); current = dirname(current))
    if (statOf(current)?.isDirectory() === false)
      throw new StateError("STATE_DIR_INVALID", `State directory or a folder above it is not a folder: ${current}`);
  const stateIgnore = join(stateDir, ".gitignore");
  const ignoreStats = statOf(stateIgnore);
  if (ignoreStats !== undefined && (!ignoreStats.isFile() || readText(stateIgnore) !== "*\n"))
    throw new StateError("STORE_TRACKS_LOCAL_FILES", `State folder .gitignore must be a file of "*", which keeps the folder out of git: ${stateIgnore}`);
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
  // the profile path is relative and has no "..": a link on it must not take the store out of the project either
  if (profile.knowledge_store.path !== undefined && !isInside(store, root))
    throw new StateError("STORE_PATH_INVALID", `Memory store must stay inside the project root once links are followed: ${store} (root: ${root})`);
  assertStatePath(stateDir, bindingFile, home);
  let bound = statOf(bindingFile) !== undefined;
  if (bound) assertBoundTo(readBinding(bindingFile, profile), root, bindingFile);
  const storeRepository = await repositoryAt(store, clone);
  if (storeRepository === "not a repository") throw notRepository(store);
  // an existing area that is not the store is checked too and gets the exclude line; one without git is used as it is
  let areaRepository = store === area ? storeRepository : await repositoryAt(area, clone);
  const stateRel = relative(area, stateDir);
  if (store === area && storeRepository !== "absent") await assertLocalFilesOutOfGit(store, stateRel, store);

  // only from here on is anything written. The repositories are made in temporary folders, and the binding claims the area
  // (inside the area put in place, or linked into one that exists) before the store is put in place or the state folder is
  // made: a boot refused for another root leaves nothing behind
  const { remote } = profile.knowledge_store;
  const cloneOptions = remote === undefined ? undefined : { remote, timeoutMs: options.cloneTimeoutMs ?? 120_000 };
  const binding: ProjectBinding = {
    project_id: profile.project_id,
    project_root: root,
    profile_path: join(root, PROFILE_FILE_NAME),
    profile_hash: canonicalHash(profile),
    created_at: new Date().toISOString(),
  };
  const bindingText = JSON.stringify(binding, null, 2) + "\n";
  let storeMade: Prepared | undefined;
  let areaMade: Prepared | undefined;
  let areaPublished = false;
  try {
    if (store !== area && storeRepository === "absent") storeMade = await prepareRepository(store, home, cloneOptions);
    if (areaRepository === "absent") {
      areaMade = await prepareRepository(area, home, store === area && cloneOptions !== undefined ? { ...cloneOptions, stateRel } : undefined);
      ensureExcluded(join(areaMade.temporary, ".git", "info", "exclude"), `/${BINDING_FILE_NAME}`);
      writeNewFile(join(areaMade.temporary, BINDING_FILE_NAME), bindingText);
      // checked in the temporary folder, as the clone made it (its folders follow the umask): once the area is in place, a
      // refusal would leave it behind
      assertStatePath(join(areaMade.temporary, stateRel), join(areaMade.temporary, BINDING_FILE_NAME), home);
      areaPublished = publish(areaMade);
      if (areaPublished) {
        bound = true;
        // made here by git init or git clone, so its git folder is .git: git is not asked again once the area is in place
        areaRepository = { excludeFile: join(area, ".git", "info", "exclude") };
      } else {
        // another boot put the area in place first: its binding decides, and the area is read as it is now
        areaRepository = await repositoryAt(area, clone);
        if (typeof areaRepository !== "object") throw notRepository(area);
        bound = statOf(bindingFile) !== undefined;
        if (bound) assertBoundTo(readBinding(bindingFile, profile), root, bindingFile);
        if (store === area) await assertLocalFilesOutOfGit(area, stateRel, store);
      }
    }
    // again right before writing, on an area this boot did not put in place: the one found may not be the disk checked above
    // (another boot made it, with its own profile)
    if (!areaPublished) assertStatePath(stateDir, bindingFile, home);
    if (!bound && !linkNewFile(area, bindingFile, bindingText)) assertBoundTo(readBinding(bindingFile, profile), root, bindingFile);
    if (typeof areaRepository === "object") ensureExcluded(areaRepository.excludeFile, `/${BINDING_FILE_NAME}`);
    // a store put at the declared path meanwhile, by a boot of the same root, is used as it is
    if (storeMade !== undefined && !publish(storeMade) && typeof (await repositoryAt(store, clone)) !== "object") throw notRepository(store);
  } finally {
    discard(storeMade);
    discard(areaMade);
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // "*" keeps the whole state folder, this file included, out of the git of the area wherever state_dir puts it. Linked whole:
  // one already there was linked whole by another boot or checked above
  linkNewFile(area, join(stateDir, ".gitignore"), "*\n");
  return { log: new EventLog(stateDir, profile, version), version };
}
