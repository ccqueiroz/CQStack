> **Histórico (2026-09-24).** Registro de decisão da Fase 1 (V1, 12/09), preservado sem edição. Não descreve o estado atual: hoje workers Claude escrevem em worktrees próprios com `Read,Grep,Glob,Edit,Write` (sem Bash), e o harness executa os owned tests. Estado atual: [README](../README.md) e [docs/architecture.md](architecture.md).

# Contrato interno — Fase 1

A especificação e autorização explícitas do usuário são o design aprovado desta fase. `.cartera/harness/runtime/src/contracts.ts` fixa as interfaces antes dos workers. Mudanças desse contrato passam pelo master-orchestrator.

Escolha: pacote TypeScript isolado, JSON Schema/Ajv, SDK MCP oficial, Node child_process e Git sem shell. Alternativas consideradas: dependência dos pacotes dos apps (acoplaria reconstrução ao harness) e serviço/DB externo (complexidade desnecessária para V1). CLI e MCP invocam os mesmos serviços.

Estado deriva de eventos persistidos por tarefa. Locks de exclusão usam criação exclusiva, sem recuperação automática de locks abandonados. Contratos aprovados mantêm snapshot e hash; novos requisitos geram change requests. Worktrees detached exigem base explícita e propriedade registrada. Saída do worker é alegação validada; conclusão da tarefa exige revisão independente.

Execução de modelos vem desabilitada; dry-run funciona sem créditos. Ativação explícita na configuração e isolamento são necessários. Claude recebe allowlist de ferramentas somente leitura; escrita Claude é recusada na V1. Codex restringe sandbox e exige worktree próprio para escrita. Escopo por arquivo é verificado antes e depois; isso não substitui um sandbox de sistema operacional. Não há defesa contra um operador local malicioso com acesso aos mesmos arquivos.

Auditoria: 16 documentos lidos. Código do parser em `cartera-backend/src/shared/http/route-convention.spec.ts` confirma a correção de 12. A lista de riscos de 05 ainda diz “tende a bloquear o CI”; essa frase residual contradiz o próprio truth-pass de 05 e não é adotada. O gate não foi executado. A exigência investigativa antiga em 16 não bloqueia a autorização explícita atual de implementação, que exclui migração de endpoints e integração de produção. Produção/staging não consultados; nenhum fato operacional remoto é afirmado.

Bootstrap será compartilhado por referência à governança. Workflows existentes serão mapeados, sem reimplementação. Governança é criada em paralelo aos schemas, sem dependência de execução. Testes usam provedores falsos e repositórios temporários.
