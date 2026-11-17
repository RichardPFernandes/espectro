---
name: pri-build
description: Implementa uma issue PRI tarefa por tarefa, cada uma num subagente novo em contexto limpo, com TDD (skills incremental-implementation e test-driven-development do agent-skills) e commit por tarefa.
disable-model-invocation: true
argument-hint: "<pasta> | PRI-NNN (Leve)"
---

# /pri-build

Carregue a skill `agent-skills:incremental-implementation` e siga o processo dela,
com os ajustes abaixo. Onde divergem, valem os ajustes. O contexto vem de
`.prisma/context.json`. Nesta sessão você coordena: cada tarefa é feita por um
subagente novo (decisão D-FLX-01 de 17/11/2026).

- **Lista de tarefas.** Médio e Alto: `<pasta>/todo.md`. Leve: os ACs da issue,
  um por vez. Nunca `tasks/todo.md`.
- **Gate do plano (Médio e Alto).** Pare se `.prisma/context.json` não tiver
  `plano_aprovado`, ou se ele divergir de `shasum -a 256 <pasta>/todo.md`. Diga que o
  plano precisa passar (de novo) pelo `/pri-plan` e pela aprovação do Richard.
- **Subagente por tarefa.** Uma tarefa por vez, em ordem, sem parar entre elas. Nunca
  duas ao mesmo tempo, nunca em segundo plano. Para cada uma, chame o Agent tool com
  `subagent_type: "general-purpose"` e o modelo pelo nível:

  | Nível | Modelo do subagente |
  | -- | -- |
  | Leve | `model: "sonnet"` |
  | Médio e Alto | `model: "opus"` |

  O subagente parte sem o histórico da sessão. O brief leva só: issue e nível, o texto
  da tarefa com os ACs, os arquivos prováveis, os SHAs das tarefas anteriores, e estas
  regras:
  1. Carregue `agent-skills:test-driven-development`. Escreva o teste e veja ele falhar
     (RED); implemente o mínimo para passar (GREEN).
  2. Rode só os testes tocados: `npm run test:changed` na raiz. Nunca `npm test`
     dentro de `scripts/` ou `dashboard/`.
  3. `git add` só dos arquivos da tarefa e commit com `(Refs PRI-NNN)` no título.
  4. Não toque em outras tarefas, no `todo.md`, no PR nem no Linear. Nunca
     `pkill -f` nem `killall`; encerre só o PID que você criou.
  5. Pare e devolva, sem improvisar, se a tarefa for ambígua, se um teste não passar
     sem correção óbvia (siga `agent-skills:debugging-and-error-recovery`) ou se ela
     pedir comportamento novo sem flag desligada.
  6. Responda em até 10 linhas: arquivos, teste novo (RED visto e GREEN), SHA do
     commit e dúvidas.
- **Depois de cada tarefa,** na sessão principal: confira `git log -1` e
  `git status --porcelain` vazio, rode `npm run test:changed`, marque a tarefa no
  `todo.md` e faça commit dele. Guarde só o resumo do subagente; o próximo começa do
  zero. Se ele devolveu dúvida ou falha, resolva com uma correção óbvia num subagente
  novo ou pare e pergunte.
- **Pare e pergunte** quando:
  - a spec é ambígua;
  - a tarefa passa do nível. Comportamento novo sem flag desligada, ou algo que mexe no
    consumidor, é Alto: peça reclassificação;
  - a ação não tem volta.
- **Docs.** Tarefa só de texto não tem RED/GREEN nem precisa de subagente: edite,
  confira os links e faça o commit.
- **No fim:** liste tarefas feitas, testes novos e commits, e indique o `/pri-check`.
