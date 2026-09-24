# Verification

## Authority

The harness's deterministic verification is the only source of truth about tests. A worker's `tests_executed` and `tests_not_executed` are claims. `schemas/agent-result.schema.json` marks them as non-authoritative, and no execution path writes harness results into them.

## Engineering Apply

For each implementation unit, after the worker returns, `verifyUnit` (`runtime/src/workflow/engineering/service.ts`) does the following:

1. Snapshots the owned worktree.
2. Scans every JavaScript module in the unit's allowed paths, including imported local modules. It rejects filesystem, process and network imports, dynamically built module names, and write or exec helpers (`assertFixtureTestSafe`). This is defense in depth, not the containment boundary.
3. Runs each owned test command in the configured isolated executor (`runtime/src/execution/sandbox.ts`):
   - Docker: `--network none`, `--read-only`, a small `tmpfs`, pid and memory limits, a non-root user, and only the worktree mounted;
   - Node's permission model on top, with file access restricted to the worktree.
4. Fails with `TEST_EXECUTION_MUTATED_WORKTREE` if the tests changed the worktree.
5. Checks that the changed files (Git diff plus untracked files) are in scope and equal the worker's `changed_files`.
6. Persists `state/engineering-verifications/<task>.json` with commands, exit codes and output, and records a checkpoint commit.

The published ApplyResult v2 contains:

- `verification: { passed, commands: [{ command, exit_code }] }`, derived from that file;
- `worker_claims`, kept separate.

Reading a v2 ApplyResult whose verification diverges from the file fails with `APPLY_VERIFICATION_INVALID`. Legacy ApplyResults without `version` keep their original branch.

## Maintenance grant

A maintenance grant applies a reviewed patch to the harness's own files. It runs the owned tests itself and records them in `state/maintenance-test-runs/` plus a `maintenance.owned_test.executed` event. A failure goes to `maintenance-test-failures/`. The worker's claim is persisted unchanged.

## Evidence

- Every cited `file:line` (or range) must exist and stay in scope (`checkFileEvidence`).
- Synthesizing roles (Flow and the proposal and contract reviewers) may cite only sources already present in their inputs.
- Flow never inherits Discovery's operational scope literal.
- The proposer and the workers get a citation `pattern` in their wire schema; fixed smokes get a `file:line` pattern.

## Proof of the whole

`scripts/final-gate.sh` is the single reproducible gate. It records, without calling any provider:

- the source hash before and after;
- build, `tsc --noEmit` and the full suite (TAP with sha256);
- `workflow show` of every root compared with a baseline;
- routing snapshot invariants;
- live provider proofs verified by hash;
- leftover test directories;
- a manifest with CLI versions and config hashes.
