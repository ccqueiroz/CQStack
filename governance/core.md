# Governança central do harness

Este diretório é a fonte comum de governança para qualquer bootstrap de agente no workspace. Claude, via superfície MCP na raiz `.cartera/harness`, e Codex, via CLI, devem carregar estes mesmos documentos; uma capacidade do modelo não concede autoridade adicional.

## Precedência de contexto

Quando fontes divergirem, use esta ordem:

1. código e configuração observáveis no workspace;
2. artefatos bloqueados e aprovados, identificados por versão e hash;
3. estes documentos de governança;
4. auditoria verificada aplicável ao estado observado;
5. cápsula da tarefa;
6. saída de agentes;
7. conversa.

Intenção explícita do usuário define o objetivo e as autorizações. A precedência acima decide afirmações sobre o sistema e impede que resumo, conversa ou saída de agente substitua evidência mais forte. Fatos de produção ou staging exigem consulta ao ambiente correspondente; código local não os prova.

## Regras canônicas

- `NO_TASK_INVENTION`: não inventar tarefas, requisitos, itens de DoD ou trabalho derivado.
- `NO_SCOPE_EXPANSION`: não ampliar caminhos, comportamentos ou sistemas além da cápsula; retornar `needs_scope_expansion` quando necessário.
- `NO_UNREQUESTED_REFACTOR`: não refatorar sem necessidade direta para o objetivo autorizado.
- `NO_EXISTING_FEATURE_MODIFICATION_UNLESS_REQUIRED`: preservar comportamento existente salvo mudança exigida pelo objetivo e sustentada por evidência.
- `MINIMUM_COMPLEXITY`: escolher a menor solução que satisfaz o comportamento observável e os gates aplicáveis.
- `REUSE_BEFORE_CREATE`: procurar e avaliar padrões e artefatos existentes antes de criar equivalentes.
- `DESIGN_SYSTEM_BEFORE_DUPLICATION`: em UI, reutilizar o design system confirmado antes de duplicar componentes, tokens ou padrões.
- `API_CONTRACT_BEFORE_PARALLEL_FRONT_BACK`: bloquear trabalho paralelo de frontend e backend até existir contrato de API aprovado e bloqueado.
- `NO_UNILATERAL_API_CONTRACT_CHANGE`: nenhum agente muda sozinho um contrato bloqueado; deve retornar pedido de mudança com impactos nos dois lados.
- `VISUAL_CHANGE_REQUIRES_APPROVAL`: mudança visual requer referência visual aprovada e bloqueada antes da implementação correspondente.
- `ONE_AGENT_ONE_RESPONSIBILITY`: cada worker recebe um único papel e uma responsabilidade delimitada.
- `MINIMUM_SUFFICIENT_CONTEXT`: entregar ao worker apenas fontes, caminhos e restrições necessários ao seu papel.
- `NO_SELF_APPROVAL`: autor e implementador não aprovam seu próprio artefato ou mudança.
- `NO_SELF_DECLARED_SUCCESS`: conclusão declarada pelo worker é relato, não veredito final.
- `EVIDENCE_REQUIRED`: toda afirmação material e todo veredito devem apontar fonte e observação reproduzível.
- `USER_OBSERVABLE_ASSERTION_FIRST`: especificação, teste e review começam pelo comportamento percebido pelo usuário antes de detalhes internos.
- `WORKERS_DO_NOT_ORCHESTRATE_WORKERS`: workers não criam, coordenam nem delegam para outros workers.

## Autoridade de orquestração

Somente o papel `master-orchestrator` decompõe trabalho, emite cápsulas, coordena agentes pelo bus, controla transições, solicita aprovações e integra resultados. Workers podem pedir follow-up ou mudança por saída estruturada; não podem conceder a si mesmos caminhos, permissões, escopo ou aprovação.

Estes arquivos governam comportamento; não afirmam que os fluxos estejam automaticamente executados ou tecnicamente impostos pelo runtime atual.
