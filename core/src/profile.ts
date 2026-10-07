import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const PROFILE_FILE_NAME = "cqstack.profile.json";
export const ARTIFACT_TYPES = ["research", "plan", "commit", "test", "readme", "pull_request"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ProjectProfile {
  project_id: string;
  language: { default: string; by_artifact: Partial<Record<ArtifactType, string>> };
  commit_identity: { name: string; email: string };
  providers_required: string[];
  repositories: Array<{ id: string; path: string }>;
  knowledge_store: { path?: string; remote?: string; deliveries_dir: string };
  state_dir?: string;
}

export type ProfileErrorCode =
  | "PROFILE_PROJECT_ROOT_REQUIRED"
  | "PROFILE_PROJECT_ROOT_NOT_ABSOLUTE"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_UNREADABLE"
  | "PROFILE_EMPTY"
  | "PROFILE_INVALID_JSON"
  | "PROFILE_SCHEMA_VIOLATION";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

export function loadProfile(projectRoot: string | undefined): ProjectProfile {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "")
    throw new ProfileError(
      "PROFILE_PROJECT_ROOT_REQUIRED",
      "Project root is required; the profile is never looked up anywhere else.",
    );
  if (!isAbsolute(projectRoot))
    throw new ProfileError("PROFILE_PROJECT_ROOT_NOT_ABSOLUTE", `Project root must be an absolute path: ${projectRoot}`);

  const file = join(projectRoot, PROFILE_FILE_NAME);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR")
      throw new ProfileError("PROFILE_NOT_FOUND", `Profile not found: ${file}`);
    throw new ProfileError("PROFILE_UNREADABLE", `Profile could not be read: ${file} (${errorCode})`);
  }
  if (text.trim() === "") throw new ProfileError("PROFILE_EMPTY", `Profile is empty: ${file}`);

  let profile: unknown;
  try {
    profile = JSON.parse(text);
  } catch (error) {
    throw new ProfileError("PROFILE_INVALID_JSON", `Profile is not valid JSON: ${file}: ${(error as Error).message}`);
  }
  return profile as ProjectProfile;
}
