# Governança de contrato de API

Frontend e backend só podem implementar em paralelo quando um `ApiContract` estiver definido, revisado pelos dois lados e bloqueado por versão e hash.

Escopo do contrato: o API Contract Architect modela somente interfaces e comportamentos implementados ou consumidos pelas implementation units aprovadas. Semântica de transporte (headers, status codes, validação e erros HTTP) só entra quando alguma unit aprovada implementa ou consome esse transporte. Uma fronteira pura/de domínio modela request e response, nulabilidade, opcionalidade, datas, dinheiro, enums, paginação e apenas os erros que as units realmente representam; sem transporte, `errors` fica vazio e `headers` é um schema de objeto vazio. Os reviewers julgam o contrato de forma independente e não são obrigados a aprovar por causa desta regra.

O lock registra `contract_id`, tarefa, versão, `content_hash`, instante de aprovação, reviewers de backend e frontend e artefato fonte. A cápsula de cada worker referencia exatamente esse lock.

Um worker que encontra incompatibilidade não altera o contrato unilateralmente. Retorna `needs_contract_change` e um pedido com razão, contrato atual, proposta e impactos de frontend e backend. O `master-orchestrator` pausa consumidores, obtém review dos dois lados e emite nova versão bloqueada antes de retomar.

Sem lock, o trabalho cross-repo dependente do contrato permanece serial ou bloqueado. O código local auditado não oferece hoje um contrato OpenAPI versionado ou package compartilhado; portanto não presumir que o contrato runtime existente já satisfaz este gate.
