import { readFileSync } from "node:fs";
import type { TaskCapsule } from "../contracts.js";
import { scopePath, within } from "../storage.js";

export function checkFileEvidence(source: string, capsule: TaskCapsule, cwd: string): void {
  for (const citation of source.split(";").map(p => p.trim())) {
    const match = /^(.*?):([0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*)$/.exec(citation);
    if (!match) throw new Error("EVIDENCE_FILE_LINE_REQUIRED: " + citation);
    const file = scopePath(cwd, match[1]);
    if (!capsule.allowed_paths.some(p => within(scopePath(cwd, p), file)) || capsule.forbidden_paths.some(p => within(scopePath(cwd, p), file))) throw new Error("EVIDENCE_OUTSIDE_SCOPE");
    const lines = readFileSync(file, "utf8").split("\n");
    for (const range of match[2].split(",")) {
      const [start, end = start] = range.split("-").map(Number);
      if (start < 1 || end < start || end > lines.length) throw new Error("EVIDENCE_LINE_MISSING");
    }
  }
}

export function collectEvidenceSources(node: unknown, into = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return into;
  if (Array.isArray(node)) { for (const value of node) collectEvidenceSources(value, into); return into; }
  const record = node as Record<string, unknown>;
  if (typeof record.source === "string" && typeof record.assertion === "string") into.add(record.source);
  for (const value of Object.values(record)) collectEvidenceSources(value, into);
  return into;
}

// Consumers that only synthesize or review validated inputs (Flow, proposal
// review, API contract review) gather no evidence of their own. Their closed
// allowlist is every source already present, byte for byte, in the evidence
// of the supplied inputs plus the artifact:/task: references they received.
// Directories, listings, bare paths, absence claims and file:line citations
// that merely fall inside allowed_paths are never in it.
export function closedEvidenceAllowlist(inherited: unknown[], references: string[] = []): Set<string> {
  const allowlist = new Set<string>(references);
  for (const source of collectEvidenceSources(inherited)) if (!/^(artifact|task):/.test(source)) allowlist.add(source);
  return allowlist;
}

export function assertClosedEvidence(node: unknown, allowlist: Set<string>, code: string): void {
  for (const source of collectEvidenceSources(node)) if (!allowlist.has(source)) throw new Error(`${code}: ${source}`);
}
