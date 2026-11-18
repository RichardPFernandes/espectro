# F1.6: tarefas (PRI-179, Alto)

> Plano aprovado pelo Richard em 2026-11-18.

Cada tarefa roda num subagente novo (opus), com TDD: o teste falha antes, passa depois.
Testes: `npm run test:changed -- origin/main` na raiz. Nada de push em remote real; nomes neutros
(`repo-a`, `repo-b`, `TICKET-X`). Ler `SPEC.md` e `plan.md` desta pasta antes.

- [x] **T1. Repo na chave, `-C` e fora de repo.** AC-1, AC-2, AC-4, AC-5, AC-8.
  Em `scripts/git-push-effect.sh`: tirar `-C <dir>` dos argumentos, resolver o toplevel real do
  diretório efetivo e pôr na chave. Fora de repo: sai ≠ 0 antes de autorizar.
  Teste novo `scripts/git-push-effect.test.js`: mesmo `push -u origin TICKET-X` em `repo-a` e
  `repo-b` → os dois remotes têm a branch e há dois efeitos; dois clones do mesmo remote → dois
  efeitos; cwd, `-C` e caminho por symlink → mesma chave; diretório sem git → rc ≠ 0, git não
  roda, nenhum efeito. Falha antes: `repo-b` fica sem a branch.

- [x] **T2. Commit na chave e linha de pulo.** AC-3, AC-7.
  Incluir o sha da origem do refspec (`HEAD` sem refspec) na chave; no `DUPLICATE`, imprimir
  linha com repo e commit. Testes: commit novo no mesmo repo → remote avança, dois efeitos;
  repetição idêntica → git não roda, rc 0, linha cita repo e sha; `HEAD:TICKET-X` e
  `--force-with-lease` resolvem o sha certo. Ajustar só `assertEffectsOnce` em
  `scripts/lib/dom06-dispatch-env.test.js`: o remote fica no commit novo e há dois efeitos de push
  `fulfilled`; PR, Redmine e revogação iguais. Falha antes: o remote fica no commit antigo.

- [x] **T3. Falha gravada e spec viva.** AC-6, AC-7.
  Se o `git push` sai ≠ 0: gravar efeito `failed` (repo e rc no detalhe) e sair com o rc do git.
  Testes: remote inexistente → rc ≠ 0, efeito `failed`, nenhum `fulfilled`; nova tentativa com
  remote corrigido roda o git e grava `fulfilled`; sem `DOM06_ATTEMPT_FILE` e com Attempt revogado
  → rc 1 sem git (garantia atual). Atualizar a linha do push em `docs/capacidades/autorizacao.md`.

- [x] **T4. Formas não suportadas falham fechado.** AC-9 (decisão do Richard, 18/11/2026).
  Mais de um refspec, `--tags`, `--all`, `--mirror`, `--follow-tags`, `--prune` → rc 2 antes de
  autorizar, sem git push nem efeito. `--delete`/`-d <branch>` vira `:<branch>`. Pular o valor de
  `--recurse-submodules`. Cabeçalho: "não chama `git push`". Testes: cada forma recusada; `--delete`
  e `:branch` removem a branch do remote e gravam `fulfilled`. Falha antes: `--tags` repetido dá
  `DUPLICATE` com rc 0.

## Checkpoint

- [ ] `npm test` e `npm run check` na raiz verdes.
- [ ] Tabela de reprodução da SPEC rodada de novo (scratchpad, remotes bare): todas as linhas com
  o resultado esperado, para a Evidência do PR.
- [ ] `git diff origin/main --stat` só com os arquivos dos Limites da SPEC; `commit.md` intacto.
