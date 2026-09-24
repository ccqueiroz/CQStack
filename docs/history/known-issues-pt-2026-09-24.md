# Registro de issues do harness (versão em português, 2026-09-24 — histórica; a versão vigente é docs/known-issues.md, em inglês)

Cada item tem exatamente um status: **CLOSED** (resolvido, com evidência), **DEFERRED BY DESIGN** (decisão consciente, com motivo e critério para reabrir) ou **BLOCKED** (aberto, com o que desbloqueia). Os caminhos `E/…` apontam para `artifacts/p2-closure-20260924/`, que é local e fica fora do versionamento (`.gitignore`).

## Baseline (gate final de 2026-09-24)

- Gate: `scripts/final-gate.sh` → `E/final-gate/summary.txt` = **GATE: PASS** (terminou em 2026-09-24T11:56:56Z).
- Hash de fonte (runtime/src, runtime/tests, cli, mcp, schemas, config, roles, governance, dist e manifests): `8f04abf25d06cb5abff0e281759c41d8e8e6a41ea26bc3d04e2448cf816ce3b2`, igual antes e depois do gate.
- Suíte: 360 testes, 360 pass, 0 fail, 0 skipped. TAP sha256 `1cb90db5a386f1dcba612037705a46ab65628b3bf27b9d38c5ec0e76e4d4d250`. `tsc --noEmit` com 0 erros.
- Roots: 42.
  - 40 históricas: 15 inspecionáveis; 25 falham no `workflow show` com `CHILD_CAPSULE_INCOMPATIBLE` desde antes desta change (10 `PHASE2-*` e `PHASE3-SMOKE` -01..-07, -09..-15). O `show` das 40 é idêntico ao baseline, byte a byte.
  - 2 novas das provas ao vivo: `P2C-CODEX-ROUTING-20260924-01` e `P2C-CLAUDE-APPLY-20260924-01`.
  - Nenhuma root anterior pode ser retomada (`compatibilityHash` mudou; decisão D-07).
- Invariants dos 22 routing snapshots OK. Provas de routing 6/6 (`E/smoke-proofs.json`). `state/engineering-test-*`: 0 antes e 0 depois.

## CLOSED

- **P2.1 — keywords do wire Codex.**
  - Probes isoladas de 24/09: `allOf` e `if` rejeitados, `maxItems` aceito, `then` não isolável.
  - A probe `allOf` de 23/09 era confundida (`gen.py:7`) e não é citada.
  - `PROVIDER_WIRE_KEYWORDS.codex` continua vazio, e nenhum pin foi removido.
  - Evidência: `E/m1-codex-matrix.md`.
- **Verification Truth.**
  - ApplyResult v2 (23/09): publica a verificação do harness e separa `worker_claims`.
  - Resíduo do maintenance grant fechado: os owned tests vão para `maintenance-test-runs/` + evento `maintenance.owned_test.executed`, e o claim do worker fica intacto.
  - `agent-result.schema.json` declara `tests_executed`/`tests_not_executed` como claim não autoritativo.
  - Evidência: `E/m3-readers.md`, `E/m3-red.tap`, `E/m3-green.tap`.
- **Bash dos workers Claude.**
  - `--tools` fixado por classe: `Read,Grep,Glob,Edit,Write` para escrita, `Read,Grep,Glob` para leitura, vazio para síntese e orquestrador. Coberto por teste.
  - Prova ao vivo: unidade `completed`, `verification.passed=true`, sem Bash e sem claim de teste.
  - Evidência: `E/m4-live-write.md`.
- **R6 — Flow com allowlist vazia.** O wire não tem mais `enum: []`; só admite `blocked` com `evidence: []`. O texto rev3 deixa isso explícito. Evidência: teste "flow wire schema stays satisfiable when no evidence source is inherited".
- **R7 — literal operacional no Flow.** Runtime e wire usam a mesma allowlist (`flowEvidenceAllowlistOf`), sem o literal da Discovery. Evidência: testes "flow evidence allowlist never offers…" e "flow wire enum never offers…".
- **R10 / P2.3 — governança por role e constraints únicas (rev3).**
  - Campo `governance` em `roles/registry.json`, validado no carregamento.
  - O prompt anexa só os documentos declarados (D-08).
  - `adapter_revision: 3` com cada regra operacional uma vez por capsule; rev1 e rev2 congeladas por hash.
  - Root rev3 real até `GAP_DEFINED`.
  - Evidência: `E/m5-rev2-hash.txt`, `E/m5-show-diff.txt`.
- **P2.4 — higiene do state.**
  - Temporários com pid, removidos no fim do arquivo de teste; resíduos de pid morto varridos.
  - A suíte não deixa resíduos.
  - Os 58 legados foram removidos uma vez, com autorização (D-06).
  - Evidência: `E/m7-hygiene.txt`.
- **Routing — prova real por classe.**
  - Aliases: Luna, Sonnet 5, Sol, Astra (escalada `extreme-architecture`), Opus 5.5 e Fable 5.1 (escalada `extreme-review`).
  - Todos com `provider_invoked: true`, exit 0, hash igual ao evento e posteriores ao checkpoint.
  - `provider_smoke_tasks` = `P2C-SMOKE-*-20260924-02`.
  - Evidência: `E/smoke-proofs.json`.
- **Smoke do Codex sem citação `file:line`.**
  - Falha diagnóstica: `P2C-SMOKE-CODEX-20260924-01`.
  - O wire do `READ_ONLY_SMOKE` passou a fixar `pattern` `file:line`, com regressão; o smoke `-02` passou (D-10).
- **Atribuição do `engineering.action.failed` ao reviewer de contrato certo** (P1.2, 22/09): `contractReview` valida cada reviewer logo após sua execução.
- **Substituição explícita de contract child lia o resultado original** (22/09): `childId` passou a ser usado por `contractChildResult` e `architectReference`.

## DEFERRED BY DESIGN

- **P2.2 — `owned_test_ids` redundante com `tests_required[].unit_id`.**
  - Motivo: a coerência já é validada nas duas direções (`engineering/artifacts.ts:80,85`, agora com dois testes de regressão).
  - Custo de reabrir: v2 do `proposal.schema.json`, `oneOf` legado e roots novas, sem ganho de comportamento.
  - Evidência: `E/m6-owned-test-ids.md` (D-01).
- **Shell do Codex em `workspace-write`.**
  - O CLI não oferece escrita sem shell.
  - Contenção: sandbox do provider, snapshot antes/depois, `assertScope` e verificação determinística.
  - Reabrir quando o Codex tiver escrita sem shell.
  - Evidência: `E/m4-codex-shell.md`.
- **Projeção de `pattern` sem lookaround para o Codex.** Seria só dica de formato; o validador canônico já rejeita saídas inválidas.
- **E2E completo da Phase 3, Storybook, browser E2E e UX Guardian.** Fora do escopo até autorização futura.
- **Crescimento sem teto de `state/provider-agent-result-*.schema.json`.**
  - São persistentes por design, indexados pelo hash do conteúdo (`agent-bus/index.ts`, `providerSchema`).
  - Um teto ou coleta exige política de retenção própria.

## BLOCKED

- **Wire do Codex não expressa `completed ⇒ evidence ≥ 1` para roles com parada honesta.**
  - Observado em `P2C-CODEX-ROUTING-20260924-01`: o Gap escalado para Astra devolveu `completed` com `evidence: []`. A validação canônica rejeitou (fail-closed) e a root parou em `TRUTH_VERIFIED`.
  - A invocação real foi aceita como prova de routing (D-12).
  - Causa: a regra só existe no `allOf/if-then` canônico, que o Codex rejeita.
  - Desbloqueio: expressar a regra no wire Codex sem `allOf`/`if` (por exemplo, `anyOf` de variantes `completed` e `blocked`), numa change própria com regressão e roots novas.
  - Evidência: `E/live/codex-root-failure.md`.
- **Root `P2C-CLAUDE-APPLY-20260924-01` parada em `LOCAL_VERIFICATION`.**
  - O apply review não foi executado: o critério da prova (9.2) não o exige, e o teto de chamadas (D-11) acabou.
  - Desbloqueio: `workflow apply-review P2C-CLAUDE-APPLY-20260924-01 --execute`, com autorização de custo.
- **Parametrização do runtime para repositórios fora do Cartera.**
  - `runtime/src/doctor.ts` assume os repositórios do Cartera e o `.mcp.json` dois níveis acima.
  - Isso bloqueia uso genérico do repositório público `CQStack` (D-14), mas não a publicação.
  - Desbloqueio: change própria de configuração de repositórios.
