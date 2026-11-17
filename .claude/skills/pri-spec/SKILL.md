---
name: pri-spec
description: Escreve a SPEC de uma issue PRI Médio ou Alto com a skill spec-driven-development do agent-skills, no caminho e no tamanho do Acordo v2.
disable-model-invocation: true
model: opus
argument-hint: "<pasta>  (ex.: tasks/f1-2-teto-por-run)"
---

# /pri-spec

Carregue a skill `agent-skills:spec-driven-development` e siga o processo dela,
com os ajustes abaixo. Onde os dois divergem, valem os ajustes. A pasta vem de
`$ARGUMENTS`; o contexto (issue e nível) vem de `.prisma/context.json`. Sem esse
arquivo, rode `/pri-start` antes.

- **Nível.** Leve não tem SPEC: pare. No Médio, escreva a SPEC só se a issue não
  bastar como contrato; se bastar, diga isso e siga para o `/pri-plan`.
- **Onde.** Grave em `<pasta>/SPEC.md`, e o mapa de módulos, se houver, também na
  pasta. Nada na raiz, em `docs/` ou em `spec/`.
- **Tamanho.** Até 1 página no Médio; de 1 a 2 páginas no Alto.
- **Conteúdo.** Só quatro seções: Objetivo, Critérios de aceite, Limites (sempre /
  perguntar antes / nunca) e Fora de escopo.
  - Cada critério se escreve `AC-1`, `AC-2`… e tem um estado de falha observável.
  - Comandos, estrutura, estilo de código e estratégia de teste já estão no
    `AGENTS.md` e no `README.md`: não repita.
  - Decisões do Richard: cite o ID (`D5`, `D-GER-02`), não copie o texto.
- **Aprovação.** No Médio, não pare para pedir aprovação (regra 8; decisão D-a de
  16/11/2026). Liste as perguntas abertas e siga para o `/pri-plan`. No Alto, pare o
  turno e peça a aprovação do Richard, como a skill manda.
