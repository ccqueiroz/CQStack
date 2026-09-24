# Compatibilidade com os workflows atuais

Fontes: comandos atuais em `.claude/commands/`, auditorias 02/03/10 e estado reconciliado em 12. Os comandos são prompts interpretados pelo host. Nenhum deles foi reescrito ou convertido em executor nesta fase.

| Local canônico atual | Invocação | Entrada | Saída e mecanismo de estado | Fraqueza confirmada | Papel do harness e estratégia de reuso |
| --- | --- | --- | --- | --- | --- |
| `.claude/commands/task-sense.md` | `/task-sense <task> [repo]` | pedido original | dossiê Markdown, `00-story` e `01-task-sense` | transição manual, sem cápsula tipada | `task-sense`: preservar input literal e interpretação; futuro adapter persiste resultado pelo bus |
| `.claude/commands/discover.md` | `/discover <slug> [repo]` | `01`, código e fontes | `02-code-today.md` | seleção de evidência depende do agente; staging não é inferido do código | `discovery-backend`, `discovery-frontend`, `discovery-design-system`: dividir a leitura em responsabilidades, manter fontes verificadas |
| `.claude/commands/flow.md` | `/flow <slug> [repo]` | `01` e `02` | `03-flow.md` | depende dos fatos selecionados em `02` | `flow`: reutilizar convenção dos diagramas, explicitar referências na cápsula |
| `.claude/commands/truth.md` | `/truth <slug> [repo]` | `01`, `02`, `03` | `04-truth.md`, possível `06-tech-debt` | contexto cumulativo; não é clean-room independente | `truth`: preservar confronto pedido/código, delegar leitura independente sem raciocínio do autor |
| `.claude/commands/gap.md` | `/gap <slug> [repo]` | `01..04` | `05-gap.md`, possível `06-tech-debt` | tiers/escopo e HALT dependem de texto | `gap`: reutilizar análise por tiers; bus guarda resultado separado sem inventar tarefas |
| `.claude/commands/decide.md` | `/decide <slug> [repo]` | história, dossiê, fontes e decisões | `05-gap.md § decision` | referências externas e gate textual; não valida completude | `master-orchestrator`: preservar decisões com fonte; não criar papel fictício decide no registry |
| `.claude/commands/opsx/propose.md` | `/opsx:propose <slug> [repo]` | `01..05`, decision | change OpenSpec, proposal/design/tasks/specs, research movido; grafo do CLI OpenSpec | gate textual e dependência de CLI/host | `master-orchestrator`: futuro adapter do OpenSpec existente; não reimplementar seu artifact graph |
| `.claude/commands/review-gate.md` | `/review-gate propose\|apply\|final <slug> [repo]` | subject/research/spec/diff | veredito textual; autopilot persiste reviews por tentativa | confia em research e diff sem base fixada; isolamento depende do host | `adversarial-reviewer`, emitido pelo `master-orchestrator`: reutilizar rubrica, encapsular subject/hash e resultado independente |
| `.claude/commands/opsx/apply.md` | `/opsx:apply <slug>` | status/instructions/contextFiles OpenSpec | código e checkboxes de tasks | argumento repo diverge do uso no autopilot; estado de arquivo não isola mudanças preexistentes | `master-orchestrator` delega `backend-worker`/`frontend-worker`: futuro adapter preserva OpenSpec e usa worktree por cápsula |
| `.claude/commands/opsx/explore.md` | `/opsx:explore [argumento]` | tema/estado da change | investigação; artefatos só quando solicitados | postura textual, sem estado tipado próprio | `master-orchestrator` e discovery conforme escopo: preservar investigação sem implementação automática |
| `.claude/commands/opsx/archive.md` | `/opsx:archive [change]` | change/status e decisão de sync | move change para archive; possível sincronização de specs | aceita incompletude com confirmação e referencia skill de sync não encontrada na auditoria | `master-orchestrator`: manter operação explícita; não automatizar movimentação/sync na Fase 1 |
| `.claude/commands/opsx/autopilot.md` | `/opsx:autopilot <slug> [repo]` | tarefa/dossiê e opções do prompt | estado Markdown, reviews por tentativa, comandos encadeados | orquestração prompt-mediated; abort pode restaurar/apagar sem ownership | `master-orchestrator`: usar como mapa de intenção; futuro adapter substitui controle implícito por eventos, sem copiar abort destrutivo |
| `.claude/commands/handoff.md` | `/handoff [slug]` | transcript | `docs/handoffs/<slug>.md` | não reconcilia automaticamente Git, OpenSpec, processos e runtime | `master-orchestrator`: preservar formato legível como resumo, apontando IDs/hashes/estado canônico |

Dossiês atuais ficam em `docs/discovery/<slug>[/<repo>]`; propose os move para `openspec/changes/<slug>/research/`. Reviews arquivados são evidência histórica, não prova de execução atual. Os pares command/skill OpenSpec continuam como encontrados; não foram fundidos. Os papéis futuros da tabela pertencem ao registry entregue; o entendimento e os adapters de proposta/aplicação/review-gate possuem as extensões descritas abaixo.


## Extensão da Fase 2

As definições atuais foram reabertas antes da implementação, incluindo comandos opsx e review-gate e as skills locais propose/apply. O mapa acima preserva o estado histórico da Fase 1. `runtime/src/workflow/adapters.ts` adapta a semântica dos cinco primeiros passos com capsules/resultados e schemas `workflow-*.schema.json`.

- Task Sense preserva pedido literal, explícitos/implícitos, exclusões e DQs, sem leitura de aplicação.
- Discovery preserva fontes e triagem factual/policy, separada em filhos focados. DQ bloqueante de policy aberta impede Flow. Fonte local não é fato de staging/produção.
- Flow preserva sequência/hops/falhas; a Fase 2 autoriza releitura direta quando o Discovery não basta. Os dados estruturados permitem projeção Mermaid; o worker não escreve diagramas em aplicação.
- Truth preserva confronto tarefa × código e agora é uma invocação independente. Research é alegação, não autoridade factual.
- Gap preserva diferenças, impacto, não lacunas e incertezas, mas seus caminhos de solução por tier e `decision:` ficam deliberadamente fora do executor desta fase, conforme a especificação. Não há criação de dívida técnica ou chamada automática de propose.

A superfície equivalente é `workflow start/show/resume/artifacts` no CLI e `workflow_*` no MCP. Os comandos `.claude/commands/*` continuam funcionais como prompts anteriores; não foram redirecionados automaticamente porque estão fora dos caminhos autorizados e escrevem dossiês/change em diretórios também fora do escopo. O novo runtime não move nem apaga esses dossiês. Logo a compatibilidade preserva invocação legada, mas não afirma que uma execução legada já tenha estado canônico no bus. A conclusão da Fase 2 acrescenta os adapters estruturados descritos a seguir.


## Conclusão da Fase 2 — OPSX e review gates

As definições reais `opsx/propose.md`, `opsx/apply.md`, `review-gate.md`, `decide.md` e skills `openspec-propose`/`openspec-apply-change` foram reabertas. A tabela inicial registra a auditoria histórica; esta extensão descreve o executor atual.

| Legado | Papel no bus | Entrada canônica | Saída / semântica preservada |
|---|---|---|---|
| `/opsx:propose` | `opsx-proposer` | pedido, decisão explícita, Task Sense, Truth/Gap e refs Discovery/Flow | Proposal imutável: objetivo, solução, unidades semânticas, dependências, testes, riscos, limites e decisões pendentes |
| `/review-gate ... propose` | `opsx-propose-reviewer` | pedido, decisão, Truth/Gap, Proposal e evidência | Review Result independente ligado ao hash; escopo mínimo, não reinvenção, suficiência de testes, zero bloqueios e até dois warnings para aprovação |
| `/opsx:apply` | `opsx-implementation-worker` por unidade | Proposal aprovado, responsabilidade, paths, testes próprios, base/worktree | Apply Result, diff, saída real de testes e checkpoint; pausa em dúvida/desvio/escopo adicional |
| `/review-gate ... apply` | `opsx-apply-reviewer` | Proposal aprovado, capsules/resultados, código alterado, diff e testes | Review Result independente; somente aprovação permite REVIEW_GATE_APPLY/DONE |

O adapter preserva o conteúdo semântico de proposal/design/tasks e a decisão do PO. Não executa o grafo dinâmico do CLI OpenSpec, scaffold, movimentação do dossiê ou sincronização de checkboxes: esses arquivos continuam sob comandos legados, sem serem promovidos implicitamente a estado do bus. A fonte canônica nova são eventos e artefatos validados. Uma execução legada não concede aprovação ao Apply novo.

A aplicação legada podia começar com contextFiles disponíveis; o runtime exige aprovação atual, hash exato, decisão e worktree próprio. Não copia abort destrutivo. Revisões explícitas geram v2/v3; nenhum loop automático de raciocínio. Gap vazio não gera trabalho fictício. Exigências de API/visual/banco/recursos externos bloqueiam a execução, sem ativar fases futuras. Escritas são limitadas à fixture registrada; comandos legados não foram removidos nem redirecionados.
