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

## Níveis de processo

Fonte: [Prisma — Acordo de desenvolvimento](https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a)
(v1, aprovado pelo Richard em 09/11/2026). Vale para o desenvolvimento do
Prisma; não muda a governança que o Prisma aplica aos consumidores (PRI-145).

| Nível | Quando | O que exige |
| -- | -- | -- |
| Leve | Avaliação, planejamento, documento ou ferramenta offline, sem efeito no ciclo | Sem spec separada; uma revisão simples; aceite do Richard no fim |
| Médio | Código atrás de flag desligada, sem estado autoritativo, autorização humana ou segurança | Spec e implementação na mesma fatia; uma revisão independente; vale o AUTORIZO por lote do milestone |
| Alto | Estado autoritativo, concorrência, autorização humana, segurança, operação protegida, ligar flag ou efeito no consumidor | Processo completo: spec fina, revisão G3 independente, AUTORIZO específico, bump e readback |

- Na dúvida entre dois níveis, usa-se o maior e registra-se o motivo.
- O revisor pode subir o nível; descer, só com o Richard.
- Uma fatia é uma entrega verificável de 3 a 5 dias. Fatias vizinhas da mesma
  frente e do mesmo nível andam juntas: uma spec, uma revisão e um AUTORIZO.
- O nível fica no grupo de rótulos `Processo` da issue no Linear (Leve, Médio
  ou Alto; seleção única) e em
  `nivel_processo` do handoff (docs/handoff-contract.md).

O que nunca muda, em qualquer nível:

- Comportamento novo entra com a flag desligada.
- PR sempre em draft; o merge é do Richard.
- AUTORIZO explícito antes de qualquer coisa que afete o consumidor: bump do
  checkout vivo, religar o polling, ligar flag, operação protegida.
- Done só com evidência e aceite dos ACs pelo Richard. Pai não fecha com filha aberta.
- Nenhum dado corporativo da M&O no Linear.
- Issue não se apaga: cancela ou arquiva. Antes de qualquer limpeza, conferir
  se há filhas abertas.

Este arquivo é instrução nova do scaffold. Regras e configuração de cada
consumidor continuam no respectivo projeto; nenhum estado vivo é definido aqui.
