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
