# Testes e evidência

Testes devem provar primeiro uma afirmação observável pelo usuário. Detalhes internos entram apenas quando protegem contrato, regra de domínio, integração ou regressão material.

Cada resultado de agente registra:

- afirmação, fonte e observação para cada evidência material;
- comando realmente executado, código de saída e evidência do resultado;
- teste não executado, comando esperado e motivo;
- riscos e problemas conhecidos sem convertê-los em sucesso.

`completed` significa que o worker concluiu sua responsabilidade; não significa aprovação nem sucesso global. O `master-orchestrator` só transita para `DONE` depois dos reviews independentes e verificações requeridas. Review não aceita “passou” sem comando e saída verificáveis, nem promove estado local a fato de produção/staging.

Use a menor suíte suficiente para o risco da mudança. Integração, E2E, UX e review adversarial pertencem ao grafo futuro e continuam deferidos até seus runners e ambientes serem integrados e demonstrados.
