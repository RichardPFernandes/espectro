---
name: pri-plan
description: Quebra uma issue PRI em tarefas com a skill planning-and-task-breakdown do agent-skills, gravando plan.md e todo.md na pasta da issue.
disable-model-invocation: true
argument-hint: "<pasta>"
---

# /pri-plan

Carregue a skill `agent-skills:planning-and-task-breakdown` e siga o processo
dela, com os ajustes abaixo. Onde os dois divergem, valem os ajustes. A pasta vem
de `$ARGUMENTS`; o contexto vem de `.prisma/context.json`.

- **Entrada.** `<pasta>/SPEC.md`, se existir; senão, os ACs da issue.
- **Saída.** Grave `<pasta>/plan.md` e `<pasta>/todo.md`. Ignore `tasks/plan.md`,
  `tasks/todo.md` e o Linear como alvo de tarefas: o Linear está no limite de
  issues, e tarefa não vira issue (regra 13).
- **Tarefas.** Cada tarefa cita os ACs que atende (`AC-2`) e tem um teste que falha
  antes dela. Ordene pelas dependências.
- **Aprovação.** No Médio, não pare para pedir aprovação (regra 8; decisão D-a de
  16/11/2026). Mostre o plano em até 10 linhas e siga para o `/pri-build`. No Alto,
  pare e peça a aprovação do Richard.
