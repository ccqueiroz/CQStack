# Known issues

Each item has exactly one status:

- **CLOSED:** resolved, with evidence.
- **DEFERRED BY DESIGN:** a deliberate decision, with its reason and the criterion for reopening.
- **BLOCKED:** open, with what unblocks it.

Evidence files live in the operator's local `artifacts/` directory, which is not versioned. The Portuguese original of this register is in [history/known-issues-pt-2026-09-24.md](history/known-issues-pt-2026-09-24.md).

## Baseline (final gate, 2026-09-24)

- `scripts/final-gate.sh` → **GATE: PASS**.
- Source hash (runtime, tests, CLI, MCP, schemas, config, roles, governance, build output and manifests): `8f04abf25d06cb5abff0e281759c41d8e8e6a41ea26bc3d04e2448cf816ce3b2`, equal before and after the gate.
- Suite: 360 tests, 360 pass, 0 fail, 0 skipped. `tsc --noEmit` reports 0 errors.
- Workflow roots in the development state:
  - 40 historical roots. 15 are inspectable. 25 already failed `workflow show` with `CHILD_CAPSULE_INCOMPATIBLE` before this baseline, because their capsule text was edited in place before adapter revisions were enforced.
  - `workflow show` output of all 40 is byte-identical to the pre-change baseline.
  - 2 new roots come from the live proofs.
- Routing snapshot invariants hold, and 6/6 live routing proofs pass. Zero leftover test directories.

## CLOSED

- **Codex wire keywords.**
  - Isolated probes: `allOf` and `if` are rejected, `maxItems` is accepted. `then` cannot be isolated, because the API rejects `if` first.
  - An earlier probe was confounded (its generator matched `"all" in name`) and is no longer cited.
  - The Codex keyword list stays empty, and no pin was removed.
  - A root-level `anyOf` is rejected too (isolated probe of 2026-09-24, see the deferred wire rule below), so status-conditional rules cannot move to the Codex wire under the current `AgentResult` shape.
- **Verification authority.**
  - The v2 ApplyResult publishes the harness verification and keeps worker claims apart.
  - The maintenance grant now records owned-test runs in `maintenance-test-runs/` plus a `maintenance.owned_test.executed` event instead of overwriting the worker's claim.
  - The schema marks `tests_executed` and `tests_not_executed` as non-authoritative claims.
- **Shell for Claude workers.**
  - `--tools` is pinned per capsule class by test.
  - A live Claude worker completed a fixture unit without a shell and without claiming any test, and the harness verification passed.
- **Flow with nothing to cite.** The wire schema no longer contains `enum: []`; it admits only an honest `blocked` result with `evidence: []`. Revision 3 of the Flow text states this explicitly.
- **Operational literal offered to Flow.** Runtime and wire share one allowlist that never offers Discovery's operational scope literal.
- **Governance per role and single-statement constraints.**
  - Each role declares its governance documents in `roles/registry.json`; this is validated at load.
  - The prompt attaches only those documents.
  - Adapter revision 3 states each operational constraint once. Revisions 1 and 2 are frozen by hash.
  - A real revision 3 root reached `GAP_DEFINED`.
- **Test state hygiene.**
  - Test temporaries carry the creating pid and are removed when the test file ends. Leftovers of dead processes are swept.
  - The suite leaves nothing behind, and legacy leftovers were removed once, with approval.
- **Live proof per model class.**
  - Aliases: `luna`, `sonnet-5`, `sol`, `astra` (explicit `extreme-architecture` escalation), `opus-5.5` and `fable-5.1` (explicit `extreme-review` escalation).
  - Each has an observation with `provider_invoked: true`, exit code 0, a hash equal to its event, and a creation time after the last code checkpoint.
- **Fixed smoke without a `file:line` citation.** A Codex smoke cited the README without a line and failed the harness check. The smoke's wire schema now pins a `file:line` pattern, with a regression test, and the repeated smoke passed.
- **Live Apply proof root reaches DONE.** The root stopped at `LOCAL_VERIFICATION` for lack of budget. It was completed later with one authorized call: the independent apply review (Opus 5.5, read-only tools) approved with 0 findings and no future gates, and the root moved through `ADVERSARIAL_REVIEW → REVIEW_GATE_APPLY → DONE`.
- **Failure attributed to the wrong contract reviewer.** Each contract reviewer is now validated right after it runs.
- **Explicit replacement of a contract child read the original result.** Replacement children are now resolved by their current ID.

- **Standalone layout.**
  - `config/runtime.json` accepts an optional `workspace.root`, resolved against the harness directory, with `../..` as the default. The logical harness prefix is derived as `relative(workspace, harness)`: `""` is standalone, and a workspace that does not contain the harness fails at load with `WORKSPACE_ROOT_MUST_CONTAIN_HARNESS`.
  - The runtime no longer derives the workspace as two levels up or hard-codes `.cartera/harness`. The only remaining literals are the frozen `evidencePreflight` examples of adapter revisions 1 and 2 and the smoke's `forbidden_paths`, both kept byte-identical to preserve their hashes.
  - `doctor` inspects the repositories declared in `runtime.json` and `<workspace>/.mcp.json`.
  - Evidence: `layout.test.ts` (resolution, standalone smoke and grants, doctor targets, load-time rejection); smoke capsule hashes, review-subject entries of existing files and `workflow show` of all 42 development roots are identical before and after the change (18 render a workflow; 24 fail with `CHILD_CAPSULE_INCOMPATIBLE` identically on both sides, as they did before this change).
- **Tests that need local development state.**
  - Tests no longer read `state/events` or `state/fixtures`, assume `artifacts/`, or depend on workspace-level `AGENTS.md`/`CLAUDE.md` or sibling repositories. The review subject records absent optional files as `absent`. `layout.test.ts` proves the `absent` mechanism with its own list; the optional list in `workflow/review.ts` is covered indirectly, by the review tests passing in a clean clone without `AGENTS.md`.
  - Evidence (2026-09-24): a clean copy of the working tree (`rsync` excluding `/state`, `/artifacts`, `/scratchpad`, `/node_modules`, `/dist`) into `<ws>/.cartera/harness`, with `<ws>` holding only the harness, ran `npm ci --ignore-scripts`, build and the full suite: 368 tests, 368 pass, 0 fail (TAP sha256 `684990eaf056140061112a59050f36f9b22055242b6803e7abed4e77eea5a046`). Before this change the same layout passed 331 of 360.
  - Timing note: an independent clean-copy run reported one `TIMEOUT` (after 64 s) in the unchanged `engineering.test.ts` case "wire schemas pin every identity, reference, hash and test ownership the gates verify" (`:788`), which passed when rerun alone. It passed in all four full runs recorded for this change: the baseline before it, and the after, clean-copy and final runs with it. Treat a lone timeout there under load as a rerun signal, not a regression.

## DEFERRED BY DESIGN

- **`owned_test_ids` duplicates `tests_required[].unit_id`.**
  - The two are validated for consistency in both directions (`OWNED_TESTS_REQUIRED`, `UNSUPPORTED_OWNED_TEST`), with regression tests.
  - Removing the field needs a v2 Proposal schema, a legacy `oneOf` and fresh roots, with no behavioral gain.
- **Codex shell in `workspace-write`.**
  - The Codex CLI offers no write mode without a shell.
  - Containment: provider sandbox, before/after snapshots, `assertScope` and deterministic verification.
  - Reopen when Codex offers write access without a shell.
- **Lookaround-free `pattern` projection for Codex.** It would only be a format hint, and canonical validation already rejects invalid output.
- **Full E2E of the contract phase, Storybook, browser E2E and UX Guardian.** Deferred until authorized.
- **Status-conditional rules on the provider wire (`completed ⇒ evidence ≥ 1`).**
  - Observed: a Gap child escalated to Astra returned `completed` with `evidence: []`. Canonical validation rejected it (fail-closed), and the root stopped at `TRUTH_VERIFIED`.
  - Both providers are affected. The canonical rule lives in the top-level `allOf`/`if-then`, which the projection strips for Claude (which rejects a top-level `allOf`) and for Codex (which rejects `allOf` and `if`).
  - The proposed way around it, `anyOf` variants per status at the schema root, is rejected by Codex. Isolated probe, `codex-cli 0.156.1`, model `gpt-5.6-luna`, effort `low` (raw files in `scratchpad/codex-anyof-root-probe-20260924/`):
    - baseline, exit 0: `{"type":"object","additionalProperties":false,"required":["status","tags"],"properties":{"status":{"type":"string","enum":["completed","blocked"]},"tags":{"type":"array","items":{"type":"string"}}}}`
    - `anyOfRootTyped`, exit 1: `{"type":"object","anyOf":[{"type":"object","additionalProperties":false,"required":["status","tags"],"properties":{"status":{"type":"string","enum":["completed"]},"tags":{"type":"array","items":{"type":"string"},"minItems":1}}},{"type":"object","additionalProperties":false,"required":["status","tags"],"properties":{"status":{"type":"string","enum":["blocked"]},"tags":{"type":"array","items":{"type":"string"}}}}]}` → 400 `invalid_json_schema`: "Invalid schema for response_format 'codex_output_schema': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level."
    - `anyOfRoot` (no root `type`) also fails, but because the root has no `type`, so it is not evidence about `anyOf`.
  - The wire keeps no `evidence.minItems` for roles that may stop honestly, so `blocked` can still report an honest stop with `evidence: []`. Canonical validation keeps rejecting `completed` without evidence. Coverage: `engineering.test.ts:1148` (canonical rejection), `engineering.test.ts:1150-1155`, `core.test.ts:407` and `workflow.test.ts:512` (wire).
  - Cost when it happens: one lost provider call, recovered with an explicit `workflow_retry`.
  - Reopen when a provider accepts conditional schemas on its wire, or when `AgentResult` is reshaped so that status and its payload can be discriminated below the root.
- **Full test suite in the standalone layout.**
  - The suite runs green in a clean clone of the embedded layout. The standalone layout is covered by targeted tests (`layout.test.ts`): layout resolution, the README smoke and its grant, diagnosis boundaries, doctor targets, and rejection of an invalid workspace root at load.
  - The whole suite does not run standalone, because many tests represent the harness root and the registered repositories through the embedded layout (`.cartera/harness` as `repository_scope`, which is empty when the prefix is `""`), and `maintenance-write`/`transports` copy the harness into an embedded workspace.
  - Reopen with a canonical representation of the harness root as a repository when the prefix is empty, and with tests that pin the layout of the copies they create.
- **Unbounded growth of `state/provider-agent-result-*.schema.json`.** These files are persistent by design and keyed by content hash. A ceiling needs its own retention policy.

## BLOCKED

None.
