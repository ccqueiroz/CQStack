import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_FILE_NAME, ProfileError, loadProfile, type ProfileErrorCode } from "../src/profile.js";

const VALID_PROFILE = {
  project_id: "acme-toy",
  language: { default: "en", by_artifact: { commit: "en", pull_request: "pt-BR" } },
  commit_identity: { name: "Ada Example", email: "ada@example.com" },
  providers_required: ["alpha-llm"],
  repositories: [{ id: "app", path: "." }],
  knowledge_store: { deliveries_dir: "deliveries", remote: "git@example.com:acme/store.git" },
  state_dir: "state",
};

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "cqstack-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

function projectRootWithText(text: string): string {
  const projectRoot = temporaryDirectory();
  writeFileSync(join(projectRoot, PROFILE_FILE_NAME), text);
  return projectRoot;
}

function projectRootWithProfile(profile: unknown): string {
  return projectRootWithText(JSON.stringify(profile));
}

function profileFile(projectRoot: string): string {
  return join(projectRoot, PROFILE_FILE_NAME);
}

function withCwdProfile(action: () => void, profileDirectory = "."): void {
  const cwd = temporaryDirectory();
  mkdirSync(join(cwd, profileDirectory), { recursive: true });
  writeFileSync(
    join(cwd, profileDirectory, PROFILE_FILE_NAME),
    JSON.stringify({ ...VALID_PROFILE, project_id: "cwd-profile" }),
  );
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    action();
  } finally {
    process.chdir(originalCwd);
  }
}

function expectProfileError(action: () => unknown, code: ProfileErrorCode): string {
  let message = "";
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProfileError);
    assert.equal(error.code, code);
    message = error.message;
    return true;
  });
  return message;
}

test("[PROF-01] a valid profile is returned deep-equal to the file", () => {
  assert.deepEqual(loadProfile(projectRootWithProfile(VALID_PROFILE)), VALID_PROFILE);
});

test("[PROF-02] a missing, empty or blank project root is rejected even when the cwd has a profile", () => {
  withCwdProfile(() => {
    for (const projectRoot of [undefined, "", "   "]) {
      assert.equal(
        expectProfileError(() => loadProfile(projectRoot), "PROFILE_PROJECT_ROOT_REQUIRED"),
        "Project root is required; the profile is never looked up anywhere else.",
      );
    }
  });
});

test("[PROF-03] a relative project root is rejected even when the cwd has a profile at that path", () => {
  withCwdProfile(() => {
    for (const projectRoot of ["rel", "./rel"]) {
      assert.equal(
        expectProfileError(() => loadProfile(projectRoot), "PROFILE_PROJECT_ROOT_NOT_ABSOLUTE"),
        `Project root must be an absolute path: ${projectRoot}`,
      );
    }
  }, "rel");
});

test("[PROF-04] only <root>/cqstack.profile.json is read, never the cwd profile", () => {
  const projectRoot = projectRootWithProfile(VALID_PROFILE);
  withCwdProfile(() => {
    assert.deepEqual(loadProfile(projectRoot), VALID_PROFILE);
  });
});

test("[PROF-05] a missing profile file is rejected even when the cwd has one", () => {
  const emptyDirectory = temporaryDirectory();
  const missingDirectory = join(temporaryDirectory(), "missing");
  const regularFile = join(temporaryDirectory(), "plain-file");
  writeFileSync(regularFile, "not a directory");
  withCwdProfile(() => {
    for (const projectRoot of [emptyDirectory, missingDirectory, regularFile]) {
      assert.equal(
        expectProfileError(() => loadProfile(projectRoot), "PROFILE_NOT_FOUND"),
        `Profile not found: ${profileFile(projectRoot)}`,
      );
    }
  });
});

test("[PROF-06] a profile path that is a directory is rejected as unreadable", () => {
  const projectRoot = temporaryDirectory();
  mkdirSync(profileFile(projectRoot));
  assert.equal(
    expectProfileError(() => loadProfile(projectRoot), "PROFILE_UNREADABLE"),
    `Profile could not be read: ${profileFile(projectRoot)} (EISDIR)`,
  );
});

test("[PROF-07] an empty or blank profile file is rejected", () => {
  for (const text of ["", " \n\t "]) {
    const projectRoot = projectRootWithText(text);
    assert.equal(
      expectProfileError(() => loadProfile(projectRoot), "PROFILE_EMPTY"),
      `Profile is empty: ${profileFile(projectRoot)}`,
    );
  }
});

test("[PROF-08] a profile that is not valid JSON is rejected", () => {
  const text = "{ not json";
  const projectRoot = projectRootWithText(text);
  let expectedParserMessage = "";
  try {
    JSON.parse(text);
  } catch (error) {
    expectedParserMessage = (error as Error).message;
  }
  assert.equal(
    expectProfileError(() => loadProfile(projectRoot), "PROFILE_INVALID_JSON"),
    `Profile is not valid JSON: ${profileFile(projectRoot)}: ${expectedParserMessage}`,
  );
});

test("[LANG-02] every closed artifact key, and an empty by_artifact, is returned as declared", () => {
  const everyKey = {
    default: "en",
    by_artifact: { research: "en", plan: "pt-BR", commit: "en", test: "en", readme: "pt-BR", pull_request: "pt-BR" },
  };
  for (const language of [everyKey, { default: "en", by_artifact: {} }]) {
    const profile = { ...VALID_PROFILE, language };
    assert.deepEqual(loadProfile(projectRootWithProfile(profile)), profile);
  }
});

test("[PROV-01] providers_required is returned unchanged and in order, with unknown provider ids", () => {
  for (const providers of [["zeta-llm", "alpha-llm"], ["solo"]]) {
    const profile = { ...VALID_PROFILE, providers_required: providers };
    assert.deepEqual(loadProfile(projectRootWithProfile(profile)), profile);
  }
});

function editProfile(pointer: string, edit: (parent: any, key: string) => void): unknown {
  const profile: any = structuredClone(VALID_PROFILE);
  const keys = pointer.split("/").slice(1);
  const key = keys.pop() as string;
  edit(keys.reduce((parent, next) => parent[next], profile), key);
  return profile;
}

function profileWith(pointer: string, value: unknown): unknown {
  return editProfile(pointer, (parent, key) => {
    parent[key] = value;
  });
}

function profileWithout(pointer: string): unknown {
  return editProfile(pointer, (parent, key) => {
    delete parent[key];
  });
}

function schemaViolations(profile: unknown): string[] {
  const projectRoot = projectRootWithProfile(profile);
  const message = expectProfileError(() => loadProfile(projectRoot), "PROFILE_SCHEMA_VIOLATION");
  const prefix = `Profile does not match the schema: ${profileFile(projectRoot)}: `;
  assert.ok(message.startsWith(prefix), message);
  return message.slice(prefix.length).split("; ");
}

function assertViolation(profile: unknown, pointer: string, field?: string): void {
  const violations = schemaViolations(profile);
  const found = violations.some(
    (violation) => violation.startsWith(`${pointer} `) && (field === undefined || violation.endsWith(` (${field})`)),
  );
  assert.ok(found, `expected a violation at ${pointer}${field === undefined ? "" : ` (${field})`}: ${violations.join("; ")}`);
}

test("[PROF-09] a top-level value that is not an object is rejected", () => {
  for (const value of [null, [], "text", 42]) assertViolation(value, "/");
});

test("[PROF-09] a missing required field is rejected", () => {
  const cases: Array<[removed: string, parentPointer: string]> = [
    ["/project_id", "/"],
    ["/language", "/"],
    ["/commit_identity", "/"],
    ["/providers_required", "/"],
    ["/repositories", "/"],
    ["/knowledge_store", "/"],
    ["/language/by_artifact", "/language"],
    ["/commit_identity/name", "/commit_identity"],
    ["/commit_identity/email", "/commit_identity"],
    ["/repositories/0/id", "/repositories/0"],
    ["/repositories/0/path", "/repositories/0"],
    ["/knowledge_store/deliveries_dir", "/knowledge_store"],
  ];
  for (const [removed, parentPointer] of cases) assertViolation(profileWithout(removed), parentPointer);
});

test("[PROF-09] a value of the wrong type is rejected", () => {
  const cases: Array<[pointer: string, value: unknown]> = [
    ["/project_id", 1],
    ["/language", "en"],
    ["/language/by_artifact", []],
    ["/commit_identity", "Ada"],
    ["/providers_required", "alpha-llm"],
    ["/repositories", {}],
    ["/repositories/0", "app"],
    ["/knowledge_store/deliveries_dir", 1],
    ["/state_dir", 3],
  ];
  for (const [pointer, value] of cases) assertViolation(profileWith(pointer, value), pointer);
});

test("[PROF-09] a value outside the fixed formats is rejected", () => {
  const cases: Array<[pointer: string, values: unknown[]]> = [
    ["/project_id", ["Acme-toy", "-acme", ".acme", "a/b", "", "a".repeat(65)]],
    ["/language/default", ["english", "EN", ""]],
    ["/language/by_artifact/commit", ["English"]],
    ["/commit_identity/name", ["<Ada>", " Ada", "Ada ", "Ada\nExample", ""]],
    ["/commit_identity/email", ["ada", "ada@example", "ada example@example.com", "<ada@example.com>"]],
    ["/repositories", [[]]],
    ["/repositories/0/id", ["App", "a:b"]],
    ["/repositories/0/path", [""]],
    ["/knowledge_store/path", [""]],
    ["/knowledge_store/deliveries_dir", [""]],
    ["/knowledge_store/remote", ["-oProxyCommand=x", "has space", ""]],
    ["/state_dir", [""]],
  ];
  for (const [pointer, values] of cases) {
    for (const value of values) assertViolation(profileWith(pointer, value), pointer);
  }
});

test("[PROF-10] an unknown field at any level is rejected and named", () => {
  const cases: Array<[parentPointer: string, field: string]> = [
    ["/", "workspace"],
    ["/language", "extra"],
    ["/commit_identity", "signing_key"],
    ["/repositories/0", "default_branch"],
    ["/knowledge_store", "schema_ref"],
  ];
  for (const [parentPointer, field] of cases) {
    const pointer = parentPointer === "/" ? `/${field}` : `${parentPointer}/${field}`;
    assertViolation(profileWith(pointer, "x"), parentPointer, field);
  }
});

test("[LANG-01] a by_artifact key outside the closed list is rejected, case-sensitive", () => {
  for (const key of ["Commit", "pull-request", "docs"]) {
    assertViolation(profileWith(`/language/by_artifact/${key}`, "en"), "/language/by_artifact", key);
  }
});

test("[LANG-03] a profile without language.default is rejected", () => {
  assertViolation(profileWithout("/language/default"), "/language");
});

test("[PROV-02] a profile without providers_required is rejected, with no default provider", () => {
  assertViolation(profileWithout("/providers_required"), "/");
});

test("[PROV-03] an empty, repeated or malformed providers_required is rejected", () => {
  assertViolation(profileWith("/providers_required", []), "/providers_required");
  assertViolation(profileWith("/providers_required", ["alpha-llm", "alpha-llm"]), "/providers_required");
  for (const id of ["Alpha", "-x", "a".repeat(33)]) {
    assertViolation(profileWith("/providers_required", [id]), "/providers_required/0");
  }
});

test("[STORE-01] a knowledge_store that is not a single object is rejected", () => {
  for (const value of [[{ deliveries_dir: "deliveries" }], "store"]) {
    assertViolation(profileWith("/knowledge_store", value), "/knowledge_store");
  }
});

test("[STORE-02] a knowledge_store inside a repository entry is rejected", () => {
  assertViolation(
    profileWith("/repositories/0/knowledge_store", { deliveries_dir: "deliveries" }),
    "/repositories/0",
    "knowledge_store",
  );
});
