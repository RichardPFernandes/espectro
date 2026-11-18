---
name: pri-pr
description: Abre o PR draft de uma issue PRI no formato do Acordo v2 (template, rótulo processo, Evidência AC × prova, Refs) e atualiza o bloco de Estado da issue.
disable-model-invocation: true
model: sonnet
argument-hint: "PRI-NNN"
---

# /pri-pr

Último passo do fluxo de desenvolvimento. Exige a árvore limpa e
`~/Workspace/prisma-evidence/<issue>/<sha do HEAD>/check.json` com a revisão PASS.
Sem esse arquivo, ou com outro SHA, rode o `/pri-check` antes (o hook
`.claude/hooks/pri-fluxo.mjs` nega o `gh pr create`).

1. **Conferir:**

   ```bash
   git fetch -q origin && git status --porcelain
   git diff -M --name-status --diff-filter=AR origin/main...HEAD
   git diff -M --shortstat origin/main...HEAD -- . ':!**/package-lock.json' ':!**/*.snap' ':!**/__snapshots__/**'
   ```

   - Nenhum arquivo novo ou renomeado pode casar com `evidence*.md`,
     `handoff*.yaml` ou `handoff*.yml`.
   - No Leve, também não pode haver `tasks/**/SPEC*`, e o limite é de 400 linhas,
     sem contar lockfiles, snapshots e fixtures gerados (`.github/processo.json`).
   - Se passar do nível, peça reclassificação. Não divida o PR em silêncio.
   - **Capacidades.** Use a lista do `.prisma/context.json`, já reconferida pelo
     `/pri-check`. Para cada capacidade com spec `viva` cujo código está no diff, a página
     `docs/capacidades/<id>.md` precisa estar no diff; senão, a Evidência diz por que o
     comportamento não mudou (é o que o `processo-check` avisa).
2. **Fatia do roadmap.** Só se o `fatia` do `.prisma/context.json` não for `null`. O
   merge é do Richard e acontece depois da sessão, então o estado da fatia precisa ir
   dentro do PR, **antes do push**. Depois do merge a worktree é apagada: o que ficar
   para "marcar depois" se perde. Leia a linha da fatia em `roadmap/fase-*/FASE.md`
   (colunas `Nível`, `AUTORIZO` e `Issue no Linear`).
   - **Depois do merge, nunca commite nesta branch** (numa sessão com `.prisma/level`, o hook `pri-fluxo.mjs` nega
     `git commit` e `git push` quando o PR dela já foi mesclado ou fechado). Se só
     depois do merge ficar claro que a fatia fechou, crie uma branch nova a partir de
     `origin/main` e abra um PR só com a linha do `FASE.md`.
   - **Último PR da fatia** só quando, para **toda** issue da coluna `Issue no Linear`
     (a fatia pode ter mais de uma, como a F1.2), os ACs já saíram em PRs mesclados ou
     saem neste (caixas da issue e Estado), não há PR aberto dela
     (`gh pr list --search "PRI-NNN" --state open`) nem filha aberta. Se não der para
     conferir, não é o último.
   - **Issue compartilhada.** Se a mesma issue aparece em outras linhas de fatia (como a
     PRI-376 em toda a Fase 0), esta regra substitui a anterior para essa issue: conte
     só os ACs **desta fatia** (semente no `FASE.md`, ou os critérios de saída que citam
     a fatia) e os PRs abertos que citam o ID dela, casado exatamente
     (`gh pr list --state open --search "<Fx.y> in:title" --json number,title` e filtre
     o título por `\b<Fx\.y>\b`, para F0.1 não casar F0.10). O resto da issue não segura
     a fatia. Sem AC próprio identificável, ou sem como conferir, não é o último.
   - **Último, e Leve ou Médio com AUTORIZO `Não`:** troque o `Status` da linha por
     `concluída` e faça commit `docs(roadmap): <Fx.y> concluída (Refs PRI-NNN)`.
   - **Último, mas Alto ou com AUTORIZO `Sim`:** o merge vem antes do AUTORIZO, do bump e
     do readback (regra 11). Deixe `em andamento`; `ligada` e `concluída` entram só depois
     do aceite do Richard, em outro PR ou à mão.
   - **Não é o último:** o `Status` fica `em andamento`; corrija se estiver
     `não iniciada` ou `em spec`.
   - **Resto da linha, em qualquer ramo:** se o rótulo `Processo` da issue não bate com
     a coluna `Nível`, troque o `Nível` só se a reclassificação tem decisão registrada
     (subir de nível é do Richard; regra 7), cite a decisão na coluna `Issue no Linear`
     e confira se a coluna `AUTORIZO` continua coerente (Alto pede `Sim`); se não
     estiver, avise em vez de editar. Se a coluna `Issue no Linear` não tem a issue do
     contexto (por exemplo, "sem issue"), acrescente `PRI-NNN`.
   - **Critério de saída da fase:** só no ramo "Último, e Leve ou Médio com AUTORIZO
     `Não`". Troque `- [ ]` por `- [x]` num critério quando **todas** as fatias que ele
     cita estão `concluída` (contando esta) ou, se ele não cita fatia, quando o
     entregável é desta fatia; e a Evidência do PR traz uma linha com o critério e a
     prova na `main` mais este PR. Na dúvida, não marque.
   - Em qualquer ramo que edite o `FASE.md`: mude só a linha da fatia e o critério de
     saída marcado. Depois de `git fetch -q origin`, confira que
     `git diff origin/main -- roadmap/` só mostra essas linhas. Se aparecer linha de
     outra fatia, a branch está atrás da `main` e o merge desfaria a mudança de outro PR
     (foi o que o #191 fez com a F0.10): traga a `main` com `git merge origin/main` antes
     do push. Rode `node scripts/lib/roadmap-lint.js` (0 erro) e, se o arquivo já
     estiver certo (por exemplo, ajustado numa tarefa do `/pri-build`), não commite nada.
   - **O commit muda o HEAD**, e o hook exige `check.json` no HEAD. Rode o `/pri-check`
     de novo antes do push, passo 3. Como o diff novo é só o `FASE.md`, a
     seção 2 do `/pri-check` vale com um `agent-skills:code-reviewer` novo que confere só
     esse diff, e o `check.json` leva `conferencia_de` com o SHA revisado antes.
     Prefira ajustar o `FASE.md` numa tarefa do `/pri-build`, antes do `/pri-check`: o
     HEAD não muda.
   - Nunca marque `concluída` uma fatia com AC pendente nem altere a linha de outra
     fatia.
3. **Push:** `git push -u origin HEAD`.
4. **Corpo do PR.** Escreva fora da worktree (no scratchpad) a partir de
   `.github/pull_request_template.md`, sem deixar marcador `<...>`:
   - **Nível** e **Issue:** `Refs PRI-NNN`, mais o ID da fatia se houver.
   - **O que muda:** 2 a 3 linhas do ponto de vista de quem usa.
   - **Delta de capacidade.** Leve: copie o `~/Workspace/prisma-evidence/<issue>/delta.md`
     do `/pri-check`, ajustado ao diff final. Médio e Alto: uma linha "ver
     `tasks/<pasta>/SPEC.md`, seção Delta de capacidade". Sem mudança de comportamento
     descrito: "Nenhum" e o motivo.
   - **Evidência:** uma linha por AC, com o resultado (PASS, FAIL ou UNKNOWN) e a prova.
     A prova de testes é o run da CI no SHA final (link); o pré-voo local entra só
     como apoio. A revisão independente entra como linha própria, com o veredito.
     Mais uma linha por capacidade tocada, `Capacidade <id>`, com PASS e a spec viva
     atualizada neste PR (os IDs que mudaram) ou, sem mudança de comportamento, o motivo
     de a página não mudar. Sem capacidade tocada, uma linha só: "Capacidade: nenhuma" e
     o motivo. Se o PR altera uma SPEC, cada AC dela também tem a sua linha (o
     `processo-check` avisa, sem reprovar, quando falta).
   - **Alto:** antes de criar o PR, rode a parte "Pedido" do `/pri-autorizo`, copie o
     `pedido.md` dele para o corpo e cite a
     SPEC (`tasks/<pasta>/SPEC.md`). Sem `## Rollback`, `## Readback` e a SPEC citada,
     o `processo-check` falha.
   - **Fica ligado?** Comportamento novo nasce atrás de flag desligada. Diga qual flag e
     qual o gatilho, ou "não se aplica" quando a mudança não tem comportamento de Run.
5. **Criar o PR:**

   ```bash
   gh pr create --draft --base main --label processo:<nivel> \
     --title "<tipo>(<escopo>): <resumo>, <Fx.y> (Refs PRI-NNN)" --body-file <arquivo>
   ```

   Termine o corpo com a linha de atribuição pedida pela sessão.
6. **Conferir os checks:** rode `gh pr checks <n> --watch` em segundo plano. A suíte
   da CI leva até 15 minutos. Se o `processo-check` falhar, corrija o corpo ou o
   rótulo. Não afrouxe a regra. Com a CI verde, ponha o link do run na Evidência
   (`gh pr edit <n> --body-file <arquivo>`).
7. **Linear.** Ao abrir o PR, edite o bloco de Estado no topo da issue (Estado,
   Próximo passo, Decisão pendente, Ligado ao fechar, Nível) com o link do PR. Não poste
   status em comentário. Comentário é só para decisão ou bloqueio, em 3 linhas.
   - **Estado:** `PR #<n> aberto em draft em AAAA-MM-DD` mais o que ele entrega (os
     ACs). Se o PR marca a fatia `concluída`, diga que o `FASE.md` vai no PR.
   - **Próximo passo:** o que falta depois dele. Leve e Médio: "Richard mescla o PR #<n>".
     Se há ACs de outro PR, nomeie o próximo AC. Alto: o AUTORIZO e o `readback`.
   - **Decisão pendente** não muda: continua manual. Ajuste só "Ligado ao fechar" se o
     escopo do PR mudou.
   - Leve e Médio: a issue vai para In Review só se precisar de decisão ou aceite do
     Richard. Mesclar é aceitar.
   - Alto: In Review, esperando o AUTORIZO do Richard. Deixe na issue o comentário de 3
     linhas do `/pri-autorizo` (Bloqueio / AUTORIZO / Efeito), com o link do PR. Depois do AUTORIZO e do bump, o próximo
     passo é `/pri-autorizo PRI-NNN readback`.
   - A fila In Review tem limite de 3 itens.
8. **Nunca** marque o PR como ready, nunca mescle, nunca use `Fixes` e nunca mova a
   issue para Done.
