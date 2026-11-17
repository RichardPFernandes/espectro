---
name: pri-plan
description: Quebra uma issue PRI em tarefas com a skill planning-and-task-breakdown do agent-skills, gravando plan.md e todo.md na pasta da issue.
disable-model-invocation: true
model: opus
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
- **Tamanho da tarefa.** Cada tarefa vai para um subagente novo no `/pri-build`, sem
  o histórico da sessão. Escreva cada uma para caber sozinha: o que fazer, os ACs, os
  arquivos prováveis e o teste que prova.
- **Gate do plano (Médio e Alto; decisão D-FLX-01 de 17/11/2026, que substitui a D-a
  no plano).** Depois de gravar `plan.md` e `todo.md`, pare:
  1. Mostre o plano em até 10 linhas: tarefas, AC de cada uma e arquivos.
  2. Marque o card do Orca, se houver (`orca worktree set --worktree active
     --workspace-status in-review --unread --comment "Aguardando Richard: plano" --json`;
     falha do `orca` não bloqueia).
  3. Espere a resposta do Richard nesta sessão. Ajuste o que ele pedir e mostre de novo.
  4. Com o OK dele: escreva no topo do `todo.md` a linha
     `> Plano aprovado pelo Richard em AAAA-MM-DD.`, faça commit de `plan.md` e
     `todo.md`, grave `"plano_aprovado": "<hash>"` em `.prisma/context.json`, com
     `<hash>` saído de `sed 's/- \[x\]/- [ ]/' <pasta>/todo.md | shasum -a 256` (as caixas marcadas no build não
     mudam o hash), e volte o card para `in-progress`.
  5. Termine com: "Plano aprovado. Dê `/clear` e rode `/pri-build <pasta>`." O build
     parte só dos arquivos; o histórico do plano não precisa ir junto.

  O `model: opus` do cabeçalho vale só no turno do `/pri-plan`; o passo 4, depois da
  resposta do Richard, roda no modelo da sessão. É mecânico, não precisa de opus.

  Esse gate não passa pela fila In Review do Linear: a fila é para decisão, aceite e
  AUTORIZO (regra 12). O Leve não tem plano nem gate.
