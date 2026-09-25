# Usage

All commands run from the harness directory.

## Layout

The harness resolves its workspace from `config/runtime.json`:

- **Embedded (default).** Without a `workspace` key, the workspace root is two levels above the harness, as in `<workspace>/.cartera/harness`. Logical paths of harness files carry the `.cartera/harness/` prefix.
- **Standalone.** Set `"workspace": { "root": "." }` to make the harness directory itself the workspace. Logical paths then have no prefix (`README.md`). Also set `repositories` to the repositories you want the harness to know (or `[]`): the versioned default lists `cartera-backend` and `cartera-frontend`, and `doctor` reports them as failures when they are missing.

`workspace.root` is resolved relative to the harness directory and must contain it. A root below the harness or beside it (for example `"runtime"` or `"../other"`) fails at load with `WORKSPACE_ROOT_MUST_CONTAIN_HARNESS`, before any state is written. The MCP configuration is always read from `<workspace>/.mcp.json`.

## Install and build

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run doctor                # checks schemas, state access, workspace repositories and MCP config
```

`doctor` inspects each repository listed in `runtime.json` under the workspace root, and `<workspace>/.mcp.json`. A missing repository or MCP file is reported as a failed check; the runtime itself still works.

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

The full suite runs from a clean clone in the embedded layout, without `state/`, `artifacts/`, workspace-level `AGENTS.md`/`CLAUDE.md` or sibling repositories: tests create the state they need in temporary directories or disposable harness copies. The standalone layout is covered by targeted tests in `runtime/tests/layout.test.ts`; running the whole suite standalone is deferred (see [known-issues.md](known-issues.md)).
