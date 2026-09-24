# Rationale

## Problem

LLM coding agents fail in ways that look like success:

- they claim tests passed;
- they widen scope;
- they cite evidence they never read;
- they approve their own work;
- they drift from the contract another agent depends on.

When several agents and two model vendors share one codebase, conversation history becomes the de facto state. That state is unverifiable and not reproducible.

## Principles

- **Capsules, not conversations.** Every worker receives one immutable capsule with a single responsibility, explicit paths and a permission ceiling. Nothing outside the capsule is authority.
- **Claims are not facts.** A worker's `completed`, its test report and its evidence are claims. The harness re-checks what it can deterministically:
  - scope and changed files;
  - that each cited file and line exists;
  - closed evidence allowlists for synthesizing roles;
  - owned tests executed by the harness itself.
- **Independent review.** Reviews are separate delegations bound to a subject hash. They never receive the author's reasoning or the orchestrator transcript.
- **Constrain at inference, validate after.** Relations the gates check byte for byte are pinned into the provider's wire schema, so the model is steered while it generates. The full canonical schema still validates the result afterwards.
- **Evidence over narrative.** Every closure needs reproducible evidence on disk: hashes, TAP output, observations and snapshots.
- **Fail closed.** Unknown states, stale locks, truncated logs, incompatible roots and invalid results stop the flow. They never degrade silently.
- **Explicit escalation only.** Frontier models are expensive and are never a default. There is no automatic fallback on failure, quota or time.

## Trade-offs

- **Local, file-based state instead of a service or database.** It is simple, inspectable and has no infrastructure. The cost: it is not a tamper-proof ledger, and recovery from crashes is manual.
- **One core, two surfaces.** MCP and CLI share behavior exactly. The cost: the CLI is the lowest common denominator.
- **Strict immutability.** Capsules, artifacts and adapter revisions never change in place, so historical roots stay inspectable. The cost: any runtime change makes incomplete roots impossible to resume; the user must start fresh roots.
- **Wire projection per provider.** Each provider receives only the schema keywords it accepts, proven by isolated probes. The cost: some rules exist only in canonical validation, and a model can still produce an output that is rejected afterwards (see [known issues](known-issues.md)).
- **Controlled fixture for writes.** Application writes stay disabled, and the write path is proven on a registered fixture repository. The cost: real-repository writes are not yet exercised.
