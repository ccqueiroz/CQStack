# Security model

## What it is

The harness is a **governance and verification layer for trusted operators**. It limits what an honest-but-fallible model agent can do and makes its output checkable:

- **Permission ceilings.** Each role has a mutation ceiling, and a capsule cannot broaden it.
- **Tool lists.**
  - Claude runs with strict empty MCP configuration, `--safe-mode` and `--restricted`.
  - Writers get `Read,Grep,Glob,Edit,Write` inside their owned worktree, with no shell.
  - Read-only producers get `Read,Grep,Glob`.
  - Synthesizers and the orchestrator get no tools.
- **Codex sandbox.** Read-only work runs in `read-only`. Writers run in `workspace-write`, which implies a shell inside the provider sandbox.
- **Scope checks.** Snapshots before and after, `assertScope` on every changed file, and changed files that must equal the declared ones.
- **Isolated test execution.** Docker with no network, a read-only root and only the worktree mounted, plus Node's permission model.
- **Quarantine.** A worktree with a failed or suspicious write is never reused or cleaned automatically.
- **Redaction.** Observations keep hashes, sizes and redacted diagnostics, never environment variables or credentials.
- **Disabled by default.** General model execution and application writes are off (`config/runtime.json`, `config/execution.json`). Live runs use narrow, single-use grants.

## What it is not

- **Not a boundary against malicious local code.** Anything running as the same OS user can edit state, events, locks or the runtime itself. The event log is append-only by convention, not tamper-proof.
- **Not an OS-authenticated approval system.** The cockpit and the core code are trusted.
- **Not a network or credential sandbox for providers.** The vendor CLIs authenticate with the operator's own login, and their network access is governed by each vendor.
- **Not full containment of the Codex shell.** Inside `workspace-write` the model can run commands allowed by the Codex sandbox; the harness contains the effects (scope, snapshots, verification), not the commands themselves. Claude tool calls are not observable in detail.
- **Git metadata and external services** are not comprehensively sandboxed by this layer.

## Operator responsibilities

- Keep provider logins personal and outside the repository.
- Inspect a stale lock (recorded PID and active processes) before removing it.
- Review quarantined worktrees manually.
- Grant live execution only for the task at hand.
