# Instruções do repositório Prisma

1. Leia README.md, docs/bootstrap.md, docs/extraction-entry.md e
   provenance/source-baseline.json antes de alterar este bootstrap.
2. Recupere a issue (bloco de Estado no topo e Agent notes) e as baselines
   pertinentes no Linear. A arquitetura congelada governa contratos, owners,
   bindings, gates e responsabilidades.
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
   Commit, com instruções locais aplicáveis e evidência atribuível à versão na
   seção Evidência do PR. Não transformar UNKNOWN ou ausência de prova em
   aprovação ou zero.
8. Impacto além da baseline retorna à reconciliação pertinente. Os candidatos
   RRC-F31-001/002 continuam NOT APPLIED até decisão governada explícita.
9. Ao concluir, atualize o bloco de Estado no topo da issue e deixe a evidência
   no PR. Bloqueio vira comentário de 3 linhas (Bloqueio / Por quê ou quem
   decide / Efeito). O handoff YAML de docs/handoff-contract.md é opcional: só
   quando o coordenador Maestri pedir uma transferência entre agentes.

## Níveis de processo (Acordo v2)

Fonte: [Prisma — Acordo de desenvolvimento](https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a)
(v2, aprovada pelo Richard em 13/11/2026; substitui a v1). Vale para o
desenvolvimento do Prisma; não muda a governança que o Prisma aplica aos
consumidores (G0–G3, PRI-145). As 10 regras curtas estão no topo do `CLAUDE.md`.

| Nível | Critério (pelo efeito) | Exige no mínimo |
| -- | -- | -- |
| Leve | Não muda código executado numa Run: docs, avaliações, ferramentas offline, testes | Issue + PR. Uma revisão. Aceite do Richard |
| Médio (padrão para código) | Muda runtime ou dashboard atrás de flag desligada ou sem efeito no consumidor | Issue com ACs + PR com evidência + uma revisão G3. Vale o AUTORIZO do milestone. SPEC de até 1 página só se for preciso |
| Alto | Muda o que já roda no consumidor: ligar flag, bump do checkout, religar polling, operação protegida, autorização humana, credencial | SPEC de 1 a 2 páginas + AUTORIZO próprio + uma rodada G3 com dois revisores + readback depois do bump. Segunda rodada só com decisão do Richard |

- Na dúvida, o nível maior, com o motivo numa linha. Subir de nível exige o
  Richard; se o trabalho passar do nível, peça reclassificação, sem adendo.
- Uma fatia leva de 3 a 5 dias e termina em algo demonstrável.
- O nível fica no grupo de rótulos `Processo` da issue no Linear (seleção
  única) e no rótulo `processo:leve|medio|alto` do PR, conferido pelo check
  `processo-check`.
- A evidência mora na seção Evidência do PR (`.github/pull_request_template.md`).
  Não há `evidence-*.md`, `handoff-*.yaml` nem adendo de SPEC por fatia.

O que nunca muda, em qualquer nível:

- Comportamento novo entra com a flag desligada.
- PR sempre em draft; o merge é do Richard. Use "Refs", nunca "Fixes".
- AUTORIZO explícito antes de qualquer coisa que afete o consumidor: bump do
  checkout vivo, religar o polling, ligar flag, operação protegida.
- Done só com evidência (no PR) e aceite dos ACs pelo Richard. Pai não fecha
  com filha aberta.
- Nenhum dado corporativo da M&O no Linear.
- Issue não se apaga: cancela ou arquiva. Antes de qualquer limpeza, conferir
  se há filhas abertas.

Este arquivo é instrução nova do scaffold. Regras e configuração de cada
consumidor continuam no respectivo projeto; nenhum estado vivo é definido aqui.
