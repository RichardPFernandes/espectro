# Instruções do repositório Prisma

1. Leia README.md, docs/bootstrap.md, docs/extraction-entry.md e
   provenance/source-baseline.json antes de alterar este bootstrap.
2. Recupere a issue, o handoff e as baselines pertinentes no Linear. A arquitetura
   congelada governa contratos, owners, bindings, gates e responsabilidades.
3. Delimite a versão da fonte, o destino, o escopo da operação e os arquivos antes
   de transportar ou adaptar implementação. Uma classificação por caminho não
   estabelece direito de cópia ou owner semântico.
4. Preserve a separação entre código da plataforma, configuração do projeto
   consumidor e estado autoritativo. Mantenha os writers e os serviços existentes
   no escopo de seus contratos; não crie engine, registry ou canal paralelo.
5. Preserve snapshots e Context Records imutáveis, S1/S2/S3 por subject e os
   gates aplicáveis. Não reinterpretar histórico por configuração latest,
   fazer rebind automático ou repetir efeito externo de resultado incerto.
6. Dados, credenciais, fixtures não admitidas, histórico e knowledge do consumidor
   não acompanham o transporte de código. Referências de configuração não são
   valores de segredo ou autorização de acesso.
7. Mudanças seguem Plan → Implement → Review independente → Test → Verify →
   Commit, com instruções locais aplicáveis e evidência atribuível à versão.
   Não transformar UNKNOWN ou ausência de prova em aprovação ou zero.
8. Impacto além da baseline retorna à reconciliação pertinente. Os candidatos
   RRC-F31-001/002 continuam NOT APPLIED até decisão governada explícita.
9. Ao concluir, bloquear ou interromper uma tarefa delegada, entregue o handoff
   de docs/handoff-contract.md, partindo de templates/handoff.yaml.template.

Este arquivo é instrução nova do scaffold. Regras e configuração de cada
consumidor continuam no respectivo projeto; nenhum estado vivo é definido aqui.
