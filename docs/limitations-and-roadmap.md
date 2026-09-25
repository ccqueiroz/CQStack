# Limitations and roadmap

## What it does

- Runs a read-only understanding workflow (Task Sense → Discovery → Flow → Truth → Gap):
  - Claude and Codex workers, routed by model class;
  - validated, hash-bound artifacts;
  - independent Truth.
- Extends a root through proposal, independent proposal review, optional API contract definition/review/lock, and controlled Apply:
  - Apply runs in owned worktrees on the registered fixture;
  - the harness verifies the owned tests itself;
  - independent apply review;
  - DONE through explicit state gates.
- Constrains providers at inference with per-provider wire schemas and deterministic pins, then validates canonically.
- Records every real provider run with a redacted observation, and proves each routed model live.
- Keeps historical roots inspectable across runtime changes (frozen adapter revisions and byte-for-byte `workflow show` checks).
- Ships one reproducible closure gate (`scripts/final-gate.sh`).

## What it does not do

- Write to real application repositories. Application writes stay disabled; only the registered fixture is writable.
- Run integration, browser E2E, UX review, Storybook or visual approval workflows. The states exist; the runners are deferred.
- Retry, fall back or escalate models automatically.
- Provide a security boundary against malicious local code (see [security-model.md](security-model.md)).
- Resume an incomplete root after a runtime change. Such a root stays inspectable, and new work needs a fresh root.
- Run the whole test suite in the standalone layout. Standalone runs are supported and covered by targeted tests; the full suite runs in the embedded layout ([known issues](known-issues.md)).

## Roadmap

- **Status-conditional wire rules.** Enforce `completed ⇒ evidence ≥ 1` on the provider wire once a provider accepts conditional schemas or `AgentResult` is reshaped; a root-level `anyOf` is rejected by Codex ([known issues](known-issues.md)).
- **Smoke per model class.** Prove every class through a fixed smoke instead of full roots.
- **Pattern projection for Codex.** Send lookaround-free patterns as format hints.
- **Claude tool-call observability.** Record Claude tool calls in observations, as Codex `command_execution` items already are.
- **Retention ceiling for wire schemas.** Bound the growth of `state/provider-agent-result-*.schema.json`.
- **Full standalone suite.** Represent the harness root as a repository when the logical prefix is empty, so every test also runs standalone.
