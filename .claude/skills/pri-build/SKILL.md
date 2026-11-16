---
name: pri-build
description: Implementa uma issue PRI tarefa por tarefa com TDD (skills incremental-implementation e test-driven-development do agent-skills), commit por tarefa, sem parar entre tarefas.
disable-model-invocation: true
argument-hint: "<pasta> | PRI-NNN (Leve)"
---

# /pri-build

Carregue as skills `agent-skills:incremental-implementation` e
`agent-skills:test-driven-development` e siga o processo delas, com os ajustes
abaixo. Onde divergem, valem os ajustes. O contexto vem de `.prisma/context.json`.

- **Lista de tarefas.** Médio e Alto: `<pasta>/todo.md`. Leve: os ACs da issue,
  um por vez. Nunca `tasks/todo.md`.
- **Laço.** Faça todas as tarefas em ordem, sem parar entre elas. Para cada uma:
  1. Escreva o teste e veja ele falhar (RED).
  2. Implemente o mínimo para passar (GREEN).
  3. Rode só o teste focado: `node --test <arquivo>`. A suíte completa é do
     `/pri-check`, não daqui; nunca rode `npm test` cru.
  4. Faça `git add` só dos arquivos da tarefa e commit com `(Refs PRI-NNN)` no título.
  5. Marque a tarefa como feita no `todo.md` (no Leve, não há `todo.md`).
- **Pare e pergunte** quando:
  - um teste não passa sem uma correção óbvia (siga `agent-skills:debugging-and-error-recovery`);
  - a spec é ambígua;
  - a tarefa passa do nível. Comportamento novo sem flag desligada, ou algo que mexe no
    consumidor, é Alto: peça reclassificação;
  - a ação não tem volta.
- **Docs.** Mudança só de texto não tem RED/GREEN: edite, confira os links e
  faça o commit.
- **No fim:** liste tarefas feitas, testes novos e commits, e indique o `/pri-check`.
