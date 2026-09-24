# Comportamento de agentes

## Bootstrap comum

Claude e Codex carregam a mesma semântica a partir de:

- [core.md](./core.md)
- [scope.md](./scope.md)
- [testing.md](./testing.md)
- [api-contract.md](./api-contract.md)
- [visual.md](./visual.md)

O host muda a forma de invocação, não a autoridade. Claude expõe o harness pela superfície MCP enraizada em `.cartera/harness`; Codex CLI usa o mesmo núcleo e os mesmos artefatos.

## Worker

Um worker:

1. aceita uma cápsula com um papel, responsabilidade, caminhos e permissão;
2. lê apenas o contexto mínimo requerido;
3. não orquestra outros workers;
4. não muda contrato, lock visual, escopo ou permissão por conta própria;
5. preserva trabalho local preexistente do usuário;
6. devolve `AgentResult` estruturado com arquivos alterados, evidências, testes, desvios, riscos e follow-ups;
7. nunca revisa, aprova ou declara sucesso global do próprio trabalho.

## Reviewer

O reviewer recebe o subject identificado por hash, critérios e fontes necessárias, sem conversa ou raciocínio do autor. Ele retorna evidência e veredito estruturado. Independência de contexto não torna o research verdadeiro: fatos materiais devem ser reconferidos na fonte de maior precedência.

## Orquestrador

O `master-orchestrator` é o único papel autorizado a operar o bus, emitir cápsulas, criar workers, ordenar estados, integrar resultados e encaminhar aprovações humanas. Deve rejeitar saída fora da cápsula e não pode substituir review independente por julgamento próprio.
