import type { TaskCapsule } from "../contracts.js";
import { harnessPath } from "../storage.js";

export function smokeCapsule(provider: string, task: string): TaskCapsule {
  if (!["codex", "claude"].includes(provider)) throw new Error("UNKNOWN_SMOKE_PROVIDER");
  return {
    task_id: task, parent_task_id: null,
    role: provider === "codex" ? "mechanical-worker" : "provider-smoke-claude",
    responsibility: "Read the harness README and report its declared runtime architecture.",
    goal: "Return a tiny AgentResult with one evidence item citing the README. Do not modify anything.",
    inputs: [], required_context: [harnessPath("README.md")],
    allowed_paths: [harnessPath("README.md")],
    forbidden_paths: ["cartera-backend", "cartera-frontend", ".git", ".env"],
    existing_patterns: [], api_contract_reference: null, visual_lock_reference: null,
    constraints: ["READ_ONLY_SMOKE", "No application reads or writes, no worktrees, no services, no network tools, no delegation. Only read the README. Keep the result under 150 words."],
    acceptance_criteria: ["Identify the shared runtime using README evidence"],
    owned_tests: [], permissions: "read-only", worktree: null, expected_output: "agent-result",
  };
}
