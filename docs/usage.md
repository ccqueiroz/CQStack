# Usage

All commands run from the harness directory. Because of the current layout limitation, that directory must be `<workspace>/.cartera/harness` (see [limitations-and-roadmap.md](limitations-and-roadmap.md)).

## Install and build

```sh
mkdir -p state artifacts      # git-ignored; some tests create temporaries in them
npm ci --ignore-scripts
npm run build
npm test
npm run doctor                # checks schemas, state access, workspace repositories and MCP config
```

`doctor` inspects `<workspace>/cartera-backend`, `<workspace>/cartera-frontend` and `<workspace>/.mcp.json`. In a workspace without them, those checks report failures. The runtime itself still works.

## CLI

`npm run cli -- <command>`:

| Command | Purpose |
| --- | --- |
| `roles` | List roles with their resolved routes |
| `task init <capsule.json> [--routing-profile <p>] [--routing-escalation <role>=<reason>]` | Create a task from a capsule |
| `task show <id>` / `task events <id>` | Inspect a task |
| `delegate <id> [--execute]` | Plan (default) or execute a delegation; execution requires `model_execution_enabled` |
| `smoke <codex\|claude> <task-id> [--execute]` | Fixed README-only provider smoke |
| `workflow start <request.json>` | Create an understanding root |
| `workflow resume <root> [--execute]` | Run the understanding stages up to `GAP_DEFINED` |
| `workflow show <root>` / `workflow artifacts <root>` | Inspect a root |
| `workflow propose <root> --execute --decision "<text>" [--revise]` | Produce a Proposal |
| `workflow proposal-review <root> --execute` | Independent proposal review |
| `workflow apply <root> --execute` | Controlled Apply on the fixture |
| `workflow apply-review <root> --execute` | Independent apply review |
| `workflow-retry <root> <failed-child> <reason>` | Explicit replacement of a failed read-only child |
| `fixture init` | Create the registered write fixture under `state/fixtures/` |
| `worktree list`, `contract show <id> <version>`, `call <tool> <input.json>` | Advanced inspection and MCP-equivalent calls |

Without `--execute`, commands inspect or plan and never call a model.

## MCP

Build first, then register the server in your MCP host, for example in `<workspace>/.mcp.json`:

```json
{ "mcpServers": { "cartera": { "type": "stdio", "command": "node", "args": [".cartera/harness/dist/mcp/server.js"] } } }
```

The tools (`task_*`, `agent_*`, `worktree_*`, `contract_*`, `workflow_*`) call the same service as the CLI. Execution defaults to false.

## Live execution

1. Authenticate the provider CLIs (`claude`, `codex`) with your own accounts.
2. Run one fixed smoke per provider with `--execute` and list the passing task IDs in `config/workflow.json` `provider_smoke_tasks`. Workflow execution checks this live gate.
3. Initialize the fixture: `npm run cli -- fixture init`.
4. Start a root from a request file with `workflow start`, then use `workflow resume <root> --execute`.
5. Continue with explicit engineering actions (`propose` → `proposal-review` → `apply` → `apply-review`).

A request names:

- the original user text;
- repositories and allowed/forbidden paths;
- constraints;
- one to six Discovery nodes;
- optionally `routing_profile` and `routing_escalations`.

See `examples/` for demonstration requests. They reference the original workspace's fixture paths.

## Recovering from failures

- **Stale lock.** A crashed run can leave `state/workflow-execution-<root>.lock`. Check the recorded PID and active processes before removing it, then `workflow resume <root> --execute`.
- **Failed read-only child.** It is replaced only explicitly (`workflow-retry`, at most two times).
- **Failed write.** It quarantines its worktree; inspect it manually.
- **Runtime change.** After changing the runtime, incomplete roots cannot resume (`WORKFLOW_VERSION_INCOMPATIBLE`). Start a fresh root. Completed roots stay inspectable.

## Scripts

| Script | Status |
| --- | --- |
| `scripts/final-gate.sh [evidence-dir]` | Current: the single reproducible closure gate |
| `scripts/bootstrap-phase3-gap.mjs` | Current dev tooling: replays a validated understanding into a fresh root at `GAP_DEFINED` |
| `scripts/export-phase-2.mjs`, `export-phase-2-completion.mjs`, `phase-2-completion-schemas.mjs`, `verify-phase-2-completion-surfaces.mjs`, `verify-phase-2-preservation.py`, `verify-fable-grant-proof.mjs`, `verify-grant-maintenance.mjs` | Historical: exporters and verifiers of earlier development phases, kept for reproducibility of past evidence |

## Clean-clone test status

The full suite passes in the development workspace. In a fresh clone placed at `<workspace>/.cartera/harness` with `state/` and `artifacts/` created, about 7 tests still fail, because they depend on local development state that is not versioned:

- historical task events under `state/events/`;
- the workspace-level `AGENTS.md` and `CLAUDE.md`, which the architecture review includes in its subject;
- the initialized write fixture under `state/fixtures/` (`npm run cli -- fixture init` creates it).

Making these tests self-contained is part of the standalone-layout work (see [known-issues.md](known-issues.md)).
