# Routing

## Model classes

`config/routing-profiles.json` holds a single `roles` table: `role → { model_class, effort }`. The classes are `orchestration`, `reasoning`, `deep-reasoning` and `mechanical`. Each profile resolves every class to one model alias:

| Class | `claude` profile | `codex` profile |
| --- | --- | --- |
| orchestration | `fable-5.1` | `astra` |
| reasoning | `opus-5.5` | `sol` |
| deep-reasoning | `opus-5.5` | `sol` |
| mechanical | `sonnet-5` | `luna` |

`config/models.json` maps each alias to a concrete provider and model identifier. Replacing a model means editing one class entry, never a role.

## Fail-closed resolution

The router (`runtime/src/router/index.ts`) rejects each of these at load time:

- a role without a class;
- a class a profile does not resolve;
- a per-role concrete model;
- a frontier model behind any class other than `orchestration` (`FRONTIER_AS_DEFAULT_FORBIDDEN`);
- a role without a declared governance list.

## Explicit frontier escalation

A `reasoning` or `deep-reasoning` role reaches the orchestration model only through an escalation declared when the root is created. The request carries `routing_escalations: { "<role>": "<reason>" }`. Valid reasons are `extreme-review`, `extreme-architecture`, `extreme-debugging` and `extreme-visual-reasoning`.

- The snapshot records the reason as `route_reason`; the orchestrator itself carries `explicit-orchestration`.
- Escalating a `mechanical` role fails with `FRONTIER_ESCALATION_CLASS_DENIED`.
- A failed review, test, schema, provider or contract never escalates.

## Snapshots

A root resolves its profile once and persists `state/routing/<root>.json` (`version: 1`). Workflow roots also store it inside their immutable manifest. Children, retries and replays reuse the snapshot. Changing the default profile or re-pointing a class never touches an existing root.

The final gate checks that every snapshot has `version: 1`, that `route_reason` marks exactly the orchestration alias, and that no Fable model appears outside orchestration.

## Live proof

Each alias has at least one observation from a real provider process. It must satisfy all of the following:

- `provider_invoked: true`;
- exit code 0;
- file hash equal to the `provider.observed` event;
- created after the last code checkpoint;
- tied to a root or smoke whose snapshot resolves that alias.

Replayed observations (`provider_invoked: false`) and observations without the field do not count.

The live provider gate (`config/workflow.json` `provider_smoke_tasks`) requires one passing fixed smoke per provider. That gate rejects Fable observations independently of routing proofs.
