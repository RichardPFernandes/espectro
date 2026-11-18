# Prisma — plataforma e entrada de desenvolvimento

> **Histórico.** Esta pasta guarda a baseline da extração de outubro de 2026 (PRI-64). É
> registro do que valia naquela revisão, não instrução atual. Para entender o sistema hoje,
> comece pelo [mapa de capacidades](../capacidades/README.md); para o fluxo de
> desenvolvimento, pelo [`CLAUDE.md`](../../CLAUDE.md) e por [`docs/fluxo-dev.md`](../fluxo-dev.md).
> O texto abaixo é a captura da extração. O que continua governando são os contratos, owners,
> bindings e gates da arquitetura congelada (item 2 do [`AGENTS.md`](../../AGENTS.md)), até
> uma decisão governada em contrário.

Prisma é a plataforma de Agentic Software Engineering extraída para o repositório privado RichardPFernandes/prisma. O app-back é o primeiro consumidor/dogfood; configuração, dados, credenciais e estado autoritativo permanecem nele.

## Leitura de entrada

- [Baseline arquitetural](architecture-baseline.md)
- [Entrada para desenvolvimento](development-entry.md)
- [Validação](validation-map.md)
- [Condições e resíduos](residual-gates.md)

## Autoridade e proveniência

Linear mantém o planejamento, decisões e Handoffs; Roadmap a arquitetura reconciliada; Git a implementação/documentação permanente; runtime/CI a prova executada. Richard decide mudanças humanas. Esta pasta é conteúdo técnico proposto, derivado da [F31](https://linear.app/prisma-app/document/f31-approved-document-final-planning-development-handoff-9d557a552a9a), não uma cópia corrente do Ledger.

A PRI-64 adapta os cinco drafts F31 ao destino entregue. O [handoff da extração](../extraction-handoff.md) identifica versões, resultados e limites; o [runbook de consumo](../consumer-operations.md) descreve a revisão fixada. A promoção documental não troca a revisão do consumidor nem incorpora o Ledger volátil.

Derivado do draft F31 de mesmo nome, adaptado na PRI-64 em 2026-10-08. Origem e hash estão em [provenance/pri-64-documentation.json](../../provenance/pri-64-documentation.json). Esta síntese preserva os contratos; decisões/status correntes ficam no Linear.
