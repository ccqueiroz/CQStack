# Escopo, contexto e propriedade

Todo worker recebe uma `TaskCapsule` com um único `role`, uma única `responsibility`, objetivo, entradas, contexto exigido, critérios de aceitação, testes próprios, permissões, caminhos permitidos e caminhos proibidos. Ausência na cápsula não é autorização implícita.

O worker deve:

1. validar que os caminhos e a permissão bastam antes de mutar;
2. trabalhar apenas nos caminhos permitidos;
3. preservar mudanças preexistentes e arquivos fora de sua responsabilidade;
4. retornar `needs_scope_expansion` com motivo, caminhos e impacto quando o objetivo exigir expansão;
5. retornar `blocked` quando a evidência ou permissão necessária não estiver disponível.

O contexto entregue deve ser o mínimo suficiente e preferir referências versionadas com hash. Não enviar o raciocínio privado do autor a um reviewer independente. Conversa resumida não substitui fonte primária.

## Trabalho local pertencente ao usuário

Mudanças preexistentes, arquivos não rastreados e deleções locais pertencem ao usuário até prova explícita em contrário. O frontend auditado possui deleções locais preexistentes; nenhum agente pode restaurá-las, removê-las, absorvê-las no próprio resultado ou usá-las como base de sucesso sem autorização explícita. Antes de integrar ou reverter, o orquestrador deve distinguir o baseline da tarefa do estado anterior do usuário.

Locks de contrato e de visual são referências imutáveis por versão e `content_hash`. Um worker não edita um artefato bloqueado; solicita mudança estruturada ao `master-orchestrator`.
