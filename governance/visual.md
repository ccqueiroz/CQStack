# Governança visual

Qualquer mudança perceptível de layout, componente, token, tipografia, cor, espaçamento, responsividade, estado ou interação exige aprovação visual antes da implementação. A aprovação gera um `visual_lock_reference` com artefato, versão e hash, incluído na cápsula.

Antes de propor algo novo, verificar o design system e os padrões existentes confirmados. Reutilizar o que satisfaz o comportamento; duplicação exige evidência de que o sistema atual não cobre a necessidade.

O worker implementa somente o lock recebido. Se o código exigir desvio, retorna `approval_required`, descreve o comportamento afetado e aguarda novo lock. O próprio autor da proposta visual não a aprova.

O frontend atual contém deleções locais pertencentes ao usuário e não fornece, no worktree auditado, prova de um design system completo e aprovado. Não restaurar conteúdo histórico nem tratá-lo automaticamente como lock visual.
