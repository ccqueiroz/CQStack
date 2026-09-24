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
- **Unbounded growth of `state/provider-agent-result-*.schema.json`.** These files are persistent by design and keyed by content hash. A ceiling needs its own retention policy.

## BLOCKED

- **The Codex wire cannot express `completed ⇒ evidence ≥ 1` for roles that may stop honestly.**
  - Observed: a Gap child escalated to Astra returned `completed` with `evidence: []`. Canonical validation rejected it (fail-closed), and the root stopped at `TRUTH_VERIFIED`. The real invocation still counts as the routing proof for Astra.
  - Cause: the rule exists only in the canonical `allOf`/`if-then`, which Codex rejects.
  - Unblock: express the rule on the Codex wire without `allOf`/`if` (for example, `anyOf` variants for `completed` and `blocked`), with a regression test and fresh roots.
- **Standalone layout.**
  - The runtime hard-codes `.cartera/harness`, computes the workspace root as two levels up, and `doctor` inspects `cartera-backend`, `cartera-frontend` and `<workspace>/.mcp.json`.
  - Unblock: a dedicated change that makes the workspace root, the harness path, the registered repositories and the MCP configuration path configurable.
- **Tests that need local development state.** Some tests read historical events or the initialized fixture from `state/`, which a fresh clone does not have. See the clean-clone note in [usage.md](usage.md).
