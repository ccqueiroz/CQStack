import { Ajv } from "ajv";
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

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const ID_SCHEMA = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" };
const LANGUAGE_TAG_SCHEMA = { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$" };
const PATH_SCHEMA = { type: "string", minLength: 1 };

const PROFILE_SCHEMA = objectSchema(
  {
    project_id: ID_SCHEMA,
    language: objectSchema(
      {
        default: LANGUAGE_TAG_SCHEMA,
        by_artifact: objectSchema(Object.fromEntries(ARTIFACT_TYPES.map((type) => [type, LANGUAGE_TAG_SCHEMA])), []),
      },
      ["default", "by_artifact"],
    ),
    commit_identity: objectSchema(
      {
        name: { type: "string", pattern: "^[^\\s<>](?:[^<>\\r\\n]*[^\\s<>])?$" },
        email: { type: "string", pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$" },
      },
      ["name", "email"],
    ),
    providers_required: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    },
    repositories: { type: "array", minItems: 1, items: objectSchema({ id: ID_SCHEMA, path: PATH_SCHEMA }, ["id", "path"]) },
    knowledge_store: objectSchema(
      // a leading "-" would turn the remote into a `git clone` option
      { path: PATH_SCHEMA, remote: { type: "string", pattern: "^[^\\s-]\\S*$" }, deliveries_dir: PATH_SCHEMA },
      ["deliveries_dir"],
    ),
    state_dir: { type: "string", minLength: 1 },
  },
  ["project_id", "language", "commit_identity", "providers_required", "repositories", "knowledge_store"],
);

const validateProfile = new Ajv({ allErrors: true, strict: true }).compile(PROFILE_SCHEMA);

function schemaViolation(file: string, violations: string[]): ProfileError {
  return new ProfileError(
    "PROFILE_SCHEMA_VIOLATION",
    `Profile does not match the schema: ${file}: ${violations.join("; ")}`,
  );
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
  if (!validateProfile(profile))
    throw schemaViolation(
      file,
      (validateProfile.errors ?? []).map((error) => {
        const field = error.params.additionalProperty;
        return `${error.instancePath || "/"} ${error.message}${field === undefined ? "" : ` (${field})`}`;
      }),
    );
  return profile as ProjectProfile;
}
