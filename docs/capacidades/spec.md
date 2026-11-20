---
id: spec
tipo: capacidade
resumo: Gera, valida, versiona e invalida a spec de cada ticket, que é a fonte dos critérios de aceite.
situacao: ligada
spec: viva
flags: []
modulos:
  - scripts/lib/spec-*
  - scripts/lib/ac-*
  - scripts/invalidate.js
  - scripts/rebuild-ac-registry.js
---

# Spec

A spec de ticket (`memory/spec/<ticket>-spec.md`, no consumidor) diz **o que** entregar; o plano
diz **como**. O `spec-generator.js` monta o rascunho a partir dos campos do ticket do Redmine, o
`spec-validator.js` pausa a spec incompleta antes do Plan e o `spec-repairer.js` sugere as seções
que faltam, sem escrever na spec. Depois da aprovação, `spec-version.js` e `spec-hash.js` fixam a
versão e o hash do contrato; uma mudança aprovada passa por `spec-change.js` e o `invalidate.js`
marca como velho tudo o que foi produzido antes. Os IDs de AC ficam em `ac-ids.js` e no registro.

## Propósito

Um agente que decide sozinho o que entregar entrega outra coisa. A spec de ticket é a única fonte
dos critérios de aceite: plano, handoff e evidência citam o critério pelo ID e nunca o reescrevem.
A capacidade garante que a spec chegue completa ao Plan, que só um humano mude o contrato depois
disso e que nada produzido sob um contrato antigo passe por atual.

## Requisitos

| ID | Comportamento | Porquê |
| -- | -- | -- |
| SPEC-R01 | Ticket sem spec ganha um rascunho montado dos campos do ticket, marcado `draft: true`. O que o ticket não traz fica vazio, e spec existente não é sobrescrita. A Run só começa quando um humano aprova o rascunho. | O gerador não inventa critério; quem valida o que entregar é uma pessoa. |
| SPEC-R02 | Spec incompleta (sem problema, solução ou critérios, com menos de 2 critérios, seção vazia ou texto curto demais) pausa antes do Plan até um aceite humano no ticket; com o aceite, segue e as pendências viram aviso. | Spec ruim multiplica falha em todos os nós; exigir preenchimento travava ticket simples. |
| SPEC-R03 | Critério com `[PENDING_CLARIFICATION]` segura o Plan até o marcador sair, mesmo com aceite. | Dúvida declarada sobre o que entregar não se resolve planejando. |
| SPEC-R04 | O validador só reporta. O reparo gera as seções que faltam como sugestão, num arquivo à parte e num comentário do ticket; só entra na spec com "aprovado", só onde a seção ainda falta, e o texto humano vence. Falha do reparo não derruba a Run. | Nenhuma ferramenta escreve requisito sem uma pessoa aprovar. |
| SPEC-R05 | O hash da spec cobre só o contrato (objetivo, escopo, critérios, regras, solução, restrições). Contexto, histórico, decisões de implementação, comentário e espaço não mudam o hash. Run anterior ao versionamento mantém o cálculo antigo. | O hash deve acusar mudança no que se entrega, não em anotação. |
| SPEC-R06 | A versão 1 é selada quando o Plan lê a spec. A versão sobe só com mudança aprovada que altera o hash; contrato reescrito entre ciclos sem mudança aprovada fica registrado com a mesma versão. O histórico de versões só recebe acréscimo. | Preencher a spec antes do Plan é autoria, não mudança. |
| SPEC-R07 | Antes de implement, review, test e verify, o hash atual é comparado com o do Plan. Diferente, sem mudança aprovada para esse hash, a Run pausa em `spec-drift`. | Ninguém troca o contrato no meio da Run sem que isso apareça. |
| SPEC-R08 | Toda decisão do implement que toca a spec é classificada: decisão técnica e esclarecimento seguem e ficam registrados; mudança de requisito pausa a Run. Remover ou enfraquecer critério, ou mudar regra, força a classificação de mudança, seja qual for a declarada. | Impede "decisão técnica: removi o AC-02". |
| SPEC-R09 | Mudança de requisito só vale com aprovação humana (resposta no ticket, botão do dashboard ou CLI com autor). Aprovada, entra no histórico da spec sem apagar nada e a Run volta ao Plan. Rejeitada, a spec fica como está e a Run segue pausada até um humano decidir. | O como pode precisar mudar; por isso volta ao Plan, nunca direto à revisão. |
| SPEC-R10 | Toda mudança aprovada marca como velhos o plano, a implementação, a revisão, a evidência e o verify, mesmo com hash igual, na Run e nas outras Runs ativas sobre a mesma spec. Nó em execução não é interrompido: a marca é aplicada quando ele termina, e até lá Verify e Commit recusam. | Hash igual não prova que replanejar é desnecessário. |
| SPEC-R11 | Critério tem ID `AC-NN`, único e em sequência. A numeração só dá ID a quem não tem. Critério cortado mantém o ID com a marca "(removido em …)"; o substituto ganha ID novo. | Plano, estado e evidência citam o ID; ele precisa apontar sempre para o mesmo critério. |
| SPEC-R12 | O Verify reprova plano ou handoff que cita critério que a spec não tem ou que reescreve o texto de um critério. | Uma segunda versão do critério vira o que o agente entrega. |
| SPEC-R13 | A origem de cada critério fica num log por ticket, só com referências; sem evidência, a origem é `UNKNOWN`. Critério proposto por agente e aprovado nunca conta como escrito por humano. O registro de critérios é índice derivado e pode ser refeito das specs. | Origem inferida seria prova falsa. |

## Invariantes

- SPEC-I01: agente nunca aprova mudança de requisito, nem a própria.
- SPEC-I02: o texto do critério vive só na spec; registro, estado e log guardam IDs e referências.
- SPEC-I03: ID de critério não é renumerado nem reaproveitado.
- SPEC-I04: artefato marcado como velho não volta a valer sem ser refeito, e evidência sem hash não comprova a spec atual.

## Flags

`SPEC_DRAFT_AUTOGEN` (R01) e `SPEC_AUTO_REPAIR` (R04) vêm ligadas e `0` desliga; são lidas no
`readmine-watcher.js`, da capacidade `ciclo-da-run`, e estão em [`docs/flags.md`](../flags.md).
Desligar a geração não libera spec com `draft: true`. As palavras de aprovação e rejeição
(`SPEC_APPROVAL_KEYWORD`, `SPEC_REJECTION_KEYWORD`) são configuração. Defeito aberto na leitura do
cabeçalho de critérios: PRI-395.

## Por onde começar

1. [`scripts/lib/spec-authority.js`](../../scripts/lib/spec-authority.js): SPEC = WHAT, PLAN = HOW, e quem pode citar a spec.
2. [`scripts/lib/spec-version.js`](../../scripts/lib/spec-version.js): `spec_version` e `spec_hash`; o ciclo de vida está em `docs/spec-versioning.md`.
3. [`scripts/lib/spec-validator.js`](../../scripts/lib/spec-validator.js): o portão de qualidade da spec.
4. [`scripts/invalidate.js`](../../scripts/invalidate.js): o que fica inválido quando o contrato muda (`docs/dependency-invalidation.md`).
5. [`scripts/lib/ac-registry.js`](../../scripts/lib/ac-registry.js): registro consultável dos critérios de aceite.
