import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentResult } from "../contracts.js";

const SCHEMA_SUFFIX = ".schema.json";
const SCHEMA_NAME = /^[a-z][a-z0-9-]*$/;

export class SchemaValidationError extends Error {
  readonly schemaName: string;
  readonly errors: ErrorObject[];

  constructor(schemaName: string, errors: ErrorObject[] = []) {
    const details = errors
      .map(
        (error) =>
          `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
      )
      .join("; ");
    super(`Value does not match ${schemaName}${details ? `: ${details}` : ""}`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.errors = errors;
  }
}

export class InvalidAgentResultError extends Error {
  readonly code = "INVALID_AGENT_RESULT" as const;
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super("INVALID_AGENT_RESULT" + (cause instanceof SchemaValidationError ? ": " + cause.schemaName + ": " + cause.errors.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ") : cause instanceof SyntaxError ? ": JSON_PARSE_FAILED" : ""));
    this.name = "InvalidAgentResultError";
    this.cause = cause;
  }
}

function findDefaultSchemaDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  let directory = moduleDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(directory, "schemas"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  candidates.push(
    resolve(process.cwd(), ".cartera/harness/schemas"),
    resolve(process.cwd(), "schemas")
  );

  const match = candidates.find((candidate) =>
    existsSync(join(candidate, "agent-result.schema.json"))
  );
  if (!match) throw new Error("Unable to locate canonical harness schemas");
  return match;
}

export class SchemaValidator {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(readonly schemaDirectory: string = findDefaultSchemaDirectory()) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value
        ) && !Number.isNaN(Date.parse(value)),
    });

    const files = readdirSync(schemaDirectory)
      .filter((file) => file.endsWith(SCHEMA_SUFFIX))
      .sort(
        (left, right) =>
          Number(left !== "common.schema.json") -
          Number(right !== "common.schema.json")
      );

    for (const file of files) {
      const document = JSON.parse(
        readFileSync(join(schemaDirectory, file), "utf8")
      ) as object;
      ajv.addSchema(document);
    }

    for (const file of files) {
      const name = file.slice(0, -SCHEMA_SUFFIX.length);
      const validator = ajv.getSchema(file);
      if (!validator) throw new Error(`Schema did not compile: ${file}`);
      this.validators.set(name, validator);
    }
  }

  validate<T>(schemaName: string, value: unknown): T {
    if (!SCHEMA_NAME.test(schemaName)) {
      throw new Error(`Invalid schema name: ${schemaName}`);
    }
    const validator = this.validators.get(schemaName);
    if (!validator) throw new Error(`Unknown schema: ${schemaName}`);
    if (!validator(value)) {
      throw new SchemaValidationError(
        schemaName,
        validator.errors ? [...validator.errors] : []
      );
    }
    return value as T;
  }
}

let defaultValidator: SchemaValidator | undefined;

export function validate<T>(schemaName: string, value: unknown): T {
  defaultValidator ??= new SchemaValidator();
  return defaultValidator.validate<T>(schemaName, value);
}

export function parseAgentResult(text: string): AgentResult {
  try {
    return validate<AgentResult>("agent-result", JSON.parse(text) as unknown);
  } catch (error) {
    throw new InvalidAgentResultError(error);
  }
}
