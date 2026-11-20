---
description: Subtarefa do Implement decomposto — executa só os passos de um grupo do plano, sem transição de nó.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/` e a este template são assets da plataforma,
> resolvidos por `PRISMA_ROOT`. Não copiar/reatar estado para corrigir paths.

Argumentos: $ARGUMENTS (`<task-id> <subtask_key>`)

Você está executando **uma subtarefa** do nó Implement de uma Run decomposta
(PRI-287 S5). O orquestrador despacha uma subtarefa por vez, na ordem do plano, e depois
uma integração (`/implement-integrate`). Quem decide o próximo passo, o aceite e a
transição de nó é o orquestrador, não você.

O bloco `<!-- subtask-context:<subtask_key>:inicio -->…<!-- subtask-context:<subtask_key>:fim -->`
no fim do prompt traz, montados pelo orquestrador: os passos do grupo (texto do plano), o
escopo de escrita (`paths_decl`), os ACs do grupo e a definição de pronto.

## Regras

1. **Só os passos do grupo.** Implemente apenas os passos listados no bloco de contexto.
   Os demais passos do plano são de outras subtarefas e não são seus.
2. **Escopo de escrita = `paths_decl`.** Escreva só nos arquivos declarados. Arquivo fora
   do escopo é registrado pelo orquestrador como `scope_violation` (não invalida o seu
   trabalho, mas o próximo Attempt desta linhagem sobe de classe). Se o passo exigir
   arquivo não declarado, o plano estava errado: pare e descreva isso no bloco de
   resultado (regra 6), sem forçar.
3. **Mesmas regras do `/implement`, por referência.** Leia
   `$PRISMA_ROOT/.claude/commands/implement.md` e aplique, para os passos do grupo:
   - o pré-processamento do contexto e o passo 0 (portão de drift da spec);
   - os passos 1 a 3b (leitura de state/handoff/plan/spec, `selected_context`, contrato
     OpenAPI, governança de decisão por `spec-change.js` — `TECHNICAL_DECISION`,
     `SPEC_CLARIFICATION`, `SPEC_CHANGE` com pausa — e pedido de autorização);
   - o passo 7 (spec como contrato vivo, só APPEND em `## Decisões de Implementação`).
   Onde o `/implement` manda parar (exit 3 do drift, exit 4 de SPEC_CHANGE ou de
   autorização), pare do mesmo jeito.
4. **Nunca mude o nó.** Não rode `state-writer.js transition`, não altere `node`,
   `history`, `retries` nem acrescente `agent_log` de nó. Não rode `/review` nem `/plan`.
   O orquestrador devolve `running` para `in_progress` sozinho quando você sair.
5. **Rework depois de gate.** Se o bloco de contexto disser "rework depois de gate", o
   bloco `<!-- review-findings:inicio -->` do `handoff.md` é o critério: resolva os
   achados que caem nos arquivos do seu escopo.
6. **Registre o resultado no `handoff.md`**, num bloco próprio desta subtarefa (crie ou
   substitua só o seu bloco; preserve todo o resto do arquivo, inclusive blocos de outras
   subtarefas):

   ```
   <!-- subtask:<subtask_key>:inicio -->
   ### Subtarefa <subtask_key>
   - Passos: <números>
   - Arquivos alterados: <lista>
   - Definição de pronto: <para cada item do bloco de contexto: feito / não feito / não se aplica, com uma linha de motivo>
   - Decisões registradas: <tipo + resumo, ou "nenhuma">
   - Pendências para a integração: <ou "nenhuma">
   <!-- subtask:<subtask_key>:fim -->
   ```

   A definição de pronto é **insumo**: o seu relato não aprova nem reprova nada. O aceite
   do orquestrador é pelo manifesto do workspace.
7. Não crie commit, branch nem push.

Pare assim que terminar o passo 6.
