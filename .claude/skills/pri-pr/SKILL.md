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
2. **Fatia do roadmap.** Só se o `fatia` do `.prisma/context.json` não for `null`. O
   merge é do Richard e acontece depois da sessão, então o estado da fatia precisa ir
   dentro do PR. Leia a linha da fatia em `roadmap/fase-*/FASE.md` (colunas `Nível`,
   `AUTORIZO` e `Issue no Linear`).
   - **Último PR da fatia** só quando, para **toda** issue da coluna `Issue no Linear`
     (a fatia pode ter mais de uma, como a F1.2), os ACs já saíram em PRs mesclados ou
     saem neste (caixas da issue e Estado), não há PR aberto dela
     (`gh pr list --search "PRI-NNN" --state open`) nem filha aberta. Se não der para
     conferir, não é o último.
   - **Último, e Leve ou Médio com AUTORIZO `Não`:** troque o `Status` da linha por
     `concluída` e faça commit `docs(roadmap): <Fx.y> concluída (Refs PRI-NNN)`.
   - **Último, mas Alto ou com AUTORIZO `Sim`:** o merge vem antes do AUTORIZO, do bump e
     do readback (regra 11). Deixe `em andamento`; `ligada` e `concluída` entram só depois
     do aceite do Richard, em outro PR ou à mão.
   - **Não é o último:** o `Status` fica `em andamento`; corrija se estiver
     `não iniciada` ou `em spec`.
   - Em qualquer ramo que edite o `FASE.md`: mude só o `Status` dessa linha, rode
     `node scripts/lib/roadmap-lint.js` (0 erro) e, se o arquivo já estiver certo (por
     exemplo, ajustado numa tarefa do `/pri-build`), não commite nada.
   - **O commit muda o HEAD**, e o hook exige `check.json` no HEAD. Rode o `/pri-check`
     de novo antes do push, passo 3. Como o diff novo é só o `Status` do `FASE.md`, a
     seção 2 do `/pri-check` vale com um `agent-skills:code-reviewer` novo que confere só
     esse diff, e o `check.json` leva `conferencia_de` com o SHA revisado antes.
     Prefira ajustar o `FASE.md` numa tarefa do `/pri-build`, antes do `/pri-check`: o
     HEAD não muda.
   - Nunca marque `concluída` uma fatia com AC pendente nem altere outra linha do
     `FASE.md`.
3. **Push:** `git push -u origin HEAD`.
4. **Corpo do PR.** Escreva fora da worktree (no scratchpad) a partir de
   `.github/pull_request_template.md`, sem deixar marcador `<...>`:
   - **Nível** e **Issue:** `Refs PRI-NNN`, mais o ID da fatia se houver.
   - **O que muda:** 2 a 3 linhas do ponto de vista de quem usa.
   - **Evidência:** uma linha por AC, com o resultado (PASS, FAIL ou UNKNOWN) e a prova.
     A prova de testes é o run da CI no SHA final (link); o pré-voo local entra só
     como apoio. A revisão independente entra como linha própria, com o veredito.
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
