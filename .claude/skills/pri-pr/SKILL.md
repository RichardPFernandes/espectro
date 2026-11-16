---
name: pri-pr
description: Abre o PR draft de uma issue PRI no formato do Acordo v2 (template, rótulo processo, Evidência AC × prova, Refs) e atualiza o bloco de Estado da issue.
disable-model-invocation: true
argument-hint: "[PRI-NNN]"
---

# /pri-pr

Último passo do fluxo de desenvolvimento. Exige o `/pri-check` com PASS e a
árvore limpa.

1. **Conferir.**
   - `git status --porcelain` vazio.
   - Sem arquivo novo `evidence*.md` ou `handoff*.yaml`.
   - No Leve: sem SPEC nova e até 400 linhas (`git diff --shortstat origin/main...HEAD`).
     Se passar disso, peça reclassificação. Não divida o PR em silêncio.
2. **Push:** `git push -u origin HEAD`.
3. **Corpo do PR.** Preencha `.github/pull_request_template.md` sem deixar
   marcador `<...>`:
   - **Nível** e **Issue:** `Refs PRI-NNN`, mais o ID da fatia se houver.
   - **O que muda:** 2 a 3 linhas do ponto de vista de quem usa.
   - **Evidência:** uma linha por AC (resultado PASS, FAIL ou UNKNOWN, e a prova: exit e
     totais da suíte, caminho do TAP, saída de comando ou print). A revisão independente
     entra como linha própria, com o veredito.
   - **Fica ligado?** Comportamento novo nasce atrás de flag desligada. Diga qual flag e
     qual o gatilho para ligar.
4. **Criar o PR:**

   ```bash
   gh pr create --draft --base main --label processo:<nivel> \
     --title "<tipo>(<escopo>): <resumo>, <Fx.y> (Refs PRI-NNN)" --body-file <arquivo>
   ```

   Termine o corpo com a linha de atribuição pedida pela sessão.
5. **Conferir o check:** `gh pr checks <n> --watch`. Se o `processo-check` falhar,
   corrija o corpo ou o rótulo. Não afrouxe a regra.
6. **Linear.** Edite o bloco de Estado no topo da issue (Estado, Próximo passo,
   Decisão pendente, Ligado ao fechar, Nível) com o link do PR. Não poste status em
   comentário: comentário só para decisão ou bloqueio, em 3 linhas.
   - Leve e Médio: a issue vai para In Review só se precisar de decisão ou aceite seu.
     Mesclar é aceitar.
   - Alto: In Review, esperando o seu aceite.
   - A fila In Review tem limite de 3 itens.
7. **Nunca:** marcar o PR como ready, mesclar, usar `Fixes` ou mover a issue para Done.
