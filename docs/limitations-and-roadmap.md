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
- Work outside the Cartera workspace layout yet. The runtime expects to live at `<workspace>/.cartera/harness` and inspects `cartera-backend`, `cartera-frontend` and `<workspace>/.mcp.json`.

## Roadmap

- **Repository parameterization.** Make the workspace root, registered repositories and MCP configuration path configurable, so a standalone clone runs without the Cartera layout.
- **Codex wire rule for honest stops.** Express `completed ⇒ evidence ≥ 1` without `allOf`/`if` (for example, with `anyOf` variants), so Codex cannot return a completed result with no evidence ([known issues](known-issues.md)).
- **Smoke per model class.** Prove every class through a fixed smoke instead of full roots.
- **Pattern projection for Codex.** Send lookaround-free patterns as format hints.
- **Claude tool-call observability.** Record Claude tool calls in observations, as Codex `command_execution` items already are.
- **Retention ceiling for wire schemas.** Bound the growth of `state/provider-agent-result-*.schema.json`.
- **Self-contained test fixtures.** Tests that need a workspace layout or state directories should create them in temporary directories.
