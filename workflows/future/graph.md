# Grafo futuro do workflow

Este é o fluxo alvo compartilhado por Claude e Codex. Estados existentes no contrato do runtime dão nome às transições; a presença neste documento não prova que integração, runners ou gates já estejam implementados.

```text
TASK → Task Sense → Discovery → Flow → Truth → Gap
     → opsx:propose → review-gate:propose
     → [API Contract necessário? definir → review front/back → lock]
     → [execução paralela quando segura, com bases/contrato explícitos]
     → [visual necessário? Storybook Proposal → User Visual Approval → Visual Lock]
     → implementação (opsx:apply) → verificação local → integração
     → Playwright Feature E2E → UX Guardian
     → review adversarial Astra/Fable por papel → review-gate:apply → DONE
```

Fable aparece somente como opção arquitetural futura; não foi configurado nem invocado na Fase 1. Aprovação e operações de coordenação são do master-orchestrator; cada responsabilidade delegada recebe sua própria cápsula.


## Regras de transição

- Cada worker recebe cápsula própria e produz `AgentResult`; somente o `master-orchestrator` coordena as operações e avança o estado pelo bus.
- `task-sense`, `discover`, `flow`, `truth`, `gap`, `decide`, `opsx-propose`, `review-gate`, `opsx-apply` e `handoff` reutilizam primeiro as superfícies atuais mapeadas em [compatibility.md](../current/compatibility.md).
- `review propose` deve ser independente do autor e verificar fontes materiais, sem confiar cegamente no dossiê.
- O gate de API é condicional. Quando frontend e backend dependem do mesmo contrato, nenhum apply paralelo começa antes de `API_CONTRACT_LOCKED`.
- O gate visual é condicional. Mudança perceptível espera `VISUAL_LOCKED` e aprovação humana.
- Qualquer pedido de mudança em lock volta ao gate correspondente, gera nova versão e exige reavaliar e substituir cápsulas dependentes antigas. Propagação automática dessa invalidação é futura.
- Integração só combina resultados dentro dos manifests de arquivos e baselines da tarefa, preservando trabalho local do usuário.

## Integrações deferidas

Os nós `integração`, `E2E da feature`, `review UX`, `review adversarial` e sua ligação automática a `review apply` são alvo futuro e permanecem deferidos. Só podem ser marcados ativos depois de existirem runner, entrada/saída estruturada, isolamento, teardown e evidência de execução. Até lá, o harness deve reportá-los como não executados, sem declarar sucesso global.


## Estado após a Fase 2

O trecho Task Sense → Discovery → Flow → Truth → Gap permanece no executor original. A extensão `runtime/src/workflow/engineering/` acrescenta Proposal, review independente, Apply controlado por unidades/worktrees e review independente final. O caminho elegível é GAP_DEFINED → PROPOSAL_CREATED → PROPOSAL_APPROVED → IMPLEMENTATION_RUNNING → LOCAL_VERIFICATION → ADVERSARIAL_REVIEW → REVIEW_GATE_APPLY → DONE. No-op não cria workers de implementação. Contratos/visual/banco/recursos externos bloqueiam Apply; nenhuma primitiva API/Visual da Fase 1 foi transformada em workflow ativo.

Fase 1: fundação. Fase 2: fluxo core até review-gate:apply. Fase 3: sistema de contratos front/back, ainda não autorizado. Integração de aplicação, E2E, UX e pipeline visual continuam futuros. O review de arquitetura do próprio harness é separado do review-gate:apply de uma tarefa. Evidência atual: `artifacts/phase-2-completion-report.md`.
