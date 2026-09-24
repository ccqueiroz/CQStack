import assert from "node:assert/strict";
import test from "node:test";
import { invoke, TOOL_DESCRIPTORS } from "../src/surface.js";

test("surface descriptors preserve Phase 1 and add shared workflow tools", async () => {
  assert.deepEqual(
    TOOL_DESCRIPTORS.map((tool) => tool.name),
    [
      "workflow_propose",
      "workflow_proposal",
      "workflow_proposal_review",
      "workflow_apply",
      "workflow_apply_review",
      "workflow_engineering_retry",
      "workflow_start",
      "workflow_show",
      "workflow_resume",
      "workflow_artifacts",
      "workflow_retry",
      "task_get",
      "task_init",
      "task_state",
      "task_events",
      "roles",
      "agent_delegate",
      "agent_result",
      "worktree_list",
      "contract_get",
      "contract_create",
      "contract_lock",
      "contract_change_request",
      "visual_lock_get",
      "worktree_create",
    ]
  );
  await assert.rejects(
    () => invoke({} as never, "missing", {}),
    /UNKNOWN_TOOL/
  );
  await assert.rejects(
    () =>
      invoke({ events: { get: () => null } } as never, "task_get", {
        task_id: 3,
      }),
    /INVALID_ARGUMENT/
  );
});
