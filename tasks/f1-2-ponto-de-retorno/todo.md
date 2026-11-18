> Plano aprovado pelo Richard em 2026-11-17.

# Tarefas F1.2 (PRI-379)

Plano: [`plan.md`](plan.md). SPEC: [`SPEC.md`](SPEC.md). Focado: `npm run test:changed`.
Suíte: `npm test` e `npm run check` (no `/pri-check`). Toda tarefa começa pelo teste que falha.
Repositórios de teste: temporários, com origem `--bare` local, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1` e autor fixo. Nunca o checkout vivo nem o app-back.

## PR A — PRI-372 (Médio, branch e worktree próprias)

- [x] **T0: testes em worktree não gravam no log de conflitos do checkout vivo (AC-05)** · S
  - Fazer: criar a worktree `../pri-372-log-conflitos` com `git worktree add -b RichardPFernandes/pri-372-log-conflitos ../pri-372-log-conflitos origin/main`. Reproduzir: rodar `scripts/lib/dom06-decomposition.test.js` com `STATE_CONFLICTS_LOG` ausente e ver para onde `logPath()` (`scripts/cas.js:439-451`) resolve. Corrigir para que nenhum teste grave fora do TMPDIR, sem mudar o caminho do log no layout real do consumidor (`<root>/memory/runs/...` e `<root>/.claude/worktrees/<id>/memory/runs/...` continuam indo para `<root>/logs`).
  - Teste que falha antes: um teste que roda o caso do dom06 dentro de uma árvore temporária com layout `<tmp>/.claude/worktrees/x/` e confere que nada aparece em `<tmp>/logs/` nem no `logs/` do checkout onde a suíte roda.
  - Não apagar a linha de fixture que já está no log vivo; só citá-la no PR (AC da PRI-372).
  - Não mexer em `harness/` (a PRI-393 T6 cuida do ambiente do harness).
  - Arquivos prováveis: `scripts/cas.js` ou `scripts/lib/dom06-decomposition.test.js`, e um teste novo ao lado.
  - Verificar: `npm run test:changed`; o `logs/` do checkout fica igual antes e depois.
  - PR em draft, `processo:medio`, "Refs PRI-372", com Estado da PRI-372 atualizado.
  - Depende de: nada.

## PR B — F1.2 (Alto, esta branch)

- [x] **T1: conferência da árvore (AC-02, base de AC-01)** · S
  - Fazer: `scripts/lib/return-point.js` com `checkTree({ root, git })` → `{ ok, reasons: ['dirty'|'off_main'|'no_origin_main'|'not_git'], paths: [até 10], head }`. Sujeira = `git status --porcelain` não vazio (ignorado não conta). Na `main` = `git merge-base --is-ancestor HEAD refs/remotes/origin/main`. Sem `fetch`. `guardEnabled(env)` lê `PRISMA_CHECKOUT_GUARD` (`1`, `true` ou `sim` liga).
  - Teste que falha antes: `scripts/lib/return-point.test.js` com árvore limpa na main (ok), arquivo modificado, arquivo não rastreado, arquivo ignorado (ok), branch fora da main, HEAD destacado numa revisão da main (ok), diretório sem git, mais de 10 caminhos sujos (lista corta em 10).
  - Arquivos: `scripts/lib/return-point.js`, `scripts/lib/return-point.test.js`.
  - Depende de: nada.

- [x] **T2: marca de último verde e log (AC-03)** · S
  - Fazer: no mesmo módulo, `lastGreen({ root })` (tag `verde/*` mais recente), `mark({ root, health, now })`: roda `health()`; se `ok`, cria a tag anotada `verde/AAAAMMDD-HHMMSS` (UTC) no HEAD com o JSON do resultado na mensagem; sempre acrescenta uma linha em `<root>/logs/return-point.jsonl` com `{at, head, tag|null, ok, items}`. Tag já existente com o mesmo nome é erro; nunca `-f`.
  - Teste que falha antes: checagem que passa cria a tag e uma linha no log; que reprova não cria tag, grava a linha e devolve `ok: false`; duas marcas seguidas fazem `lastGreen` devolver a segunda; colisão de nome não sobrescreve; o log não tem caminho absoluto.
  - Arquivos: `scripts/lib/return-point.js`, `scripts/lib/return-point.test.js`.
  - Depende de: T1.

- [x] **T3: checagem de saúde (AC-03)** · S
  - Fazer: `health({ root, baseUrl, fetch, lockStatus })` com quatro itens, cada um `pass|fail|desconhecido`: árvore (`checkTree`); dashboard (`GET /api/version`: `current.sha` igual ao HEAD e `drift: false`; sem resposta = `fail`); trava (`watcher-lock.status(root)` legível); tick (`GET /api/watcher/status`: `error` nulo e `last_run` sem queda desde a subida; sem tick desde a subida = `desconhecido`). `ok` = nenhum `fail`. URL padrão `http://127.0.0.1:${PORT||3333}`, só loopback.
  - Teste que falha antes: servidor HTTP falso em loopback cobrindo os quatro itens em pass, fail e desconhecido; URL fora de loopback é recusada.
  - Arquivos: `scripts/lib/return-point.js`, `scripts/lib/return-point.test.js`.
  - Depende de: T2.

- [x] **T4: volta ao último verde e CLI (AC-01)** · M
  - Fazer: `back({ root, to, lockStatus, watcherStatus })`: recusa sem tag verde, com árvore suja, trava `held`, agente vivo ou watcher rodando, sem mudar nada e com motivo; senão `git switch --detach <tag>`. Avisa quando `scripts/package-lock.json` ou `dashboard/package-lock.json` diferem entre o HEAD de antes e a tag, e diz que o dashboard precisa reiniciar. CLI `scripts/return-point.js <status|mark|back> [--root <dir>] [--to verde/<id>] [--json]`: exit 0 em sucesso, 1 em recusa ou reprovação, 2 em uso errado.
  - Teste que falha antes: em repo temporário, marcar, avançar dois commits, `back` deixa HEAD na tag; cada recusa sai com 1 e HEAD igual; `--to` escolhe outra tag; lock diferente gera aviso; a CLI roda como processo filho com `--root`.
  - Arquivos: `scripts/lib/return-point.js`, `scripts/return-point.js`, `scripts/lib/return-point.test.js`, `scripts/return-point.test.js`.
  - Depende de: T3.

### Checkpoint 1 (T1–T4)

- [x] `npm run test:changed` verde; `node --test scripts/capability-map.test.js` diz o dono dos arquivos novos (resolver na T6, ou já aqui se o teste bloquear).

- [x] **T5: guard na subida do dashboard e no tick (AC-02, AC-06)** · M
  - Fazer: com `guardEnabled(env)`, (a) `dashboard/server.js`, no bloco de boot antes do `listen` (`:3874`): `checkTree({ root: prismaRoot })`; recusa imprime o motivo e até 10 caminhos e sai com 2; (b) `scripts/watcher-manager.js`, em `spawnTick` antes do `spawn` (`:197`): recusa não inicia o tick, para o laço, grava `error: 'checkout_guard'` e `guard: { reasons, paths }` em `status()`, e escreve a nota no buffer de log. Raiz conferida = `PRISMA_ROOT` do processo.
  - Teste que falha antes: watcher-manager com `git` injetado contando chamadas: flag ausente = 0 chamadas e tick igual ao de hoje; flag ligada e árvore suja = nenhum `spawn`, `status().error === 'checkout_guard'`; flag ligada e árvore ok = tick normal. Dashboard como processo filho com `PRISMA_ROOT` num repo temporário sujo e a flag ligada: sai com 2, mensagem com o motivo, porta não abre.
  - Os testes atuais de `scripts/watcher-manager.test.js` e do dashboard passam sem alteração.
  - Arquivos: `scripts/watcher-manager.js`, `scripts/watcher-manager.test.js`, `dashboard/server.js`, um teste novo em `dashboard/` (`checkout-guard-boot.test.js`).
  - Depende de: T1.

- [x] **T6: flag, documentação, dono e `.gitignore` (AC-07)** · S
  - Fazer: linha `PRISMA_CHECKOUT_GUARD` em `docs/flags.md` (env, desligada, PRI-379, consumidor `não verificado`, ligar com AUTORIZO depois do ensaio, decidir até 2026-12-18, item desligado `sim`) e no `.env.example`. Em `docs/consumer-operations.md`: seção "Ponto de retorno" (comandos, o que recusa, o que fica com o Richard) e a seção "Decisão pendente: DB-13 × checkout" fechada com a D3 de 17/11. Dono dos arquivos novos: rodar `node --test scripts/capability-map.test.js` e seguir a mensagem (provável `ciclo-da-run` para o módulo e `ferramentas` para a CLI). `pnpm-lock.yaml` no `.gitignore`, com comentário de uma linha.
  - Teste que falha antes: `node --test scripts/lib/flag-registry.test.js scripts/capability-map.test.js` falha sem a linha e sem o dono.
  - Arquivos: `docs/flags.md`, `.env.example`, `docs/consumer-operations.md`, `docs/capacidades/<dono>.md`, `.gitignore`.
  - Depende de: T1–T5.

- [ ] **T7: ensaio de volta em repositório temporário (AC-04)** · XS
  - Fazer: teste `scripts/return-point-ensaio.test.js` que roda a sequência inteira pela CLI e imprime cada passo: marcar (com saúde falsa ok), avançar, sujar, `back` recusa, limpar, `back` volta, `git tag -n` e o log. A saída vai para `~/Workspace/prisma-evidence/PRI-379/<sha>/ensaio.txt` e para a Evidência do PR.
  - Arquivos: `scripts/return-point-ensaio.test.js`.
  - Depende de: T4.

### Checkpoint 2 (fim)

- [ ] `npm test` e `npm run check` verdes; `node scripts/lib/roadmap-lint.js` com 0 erros.
- [ ] PR A mesclado ou, no mínimo, aberto e citado (AC-05 só fecha com ele mesclado).
- [ ] `/pri-check` com dois revisores; `/pri-autorizo` com as quatro ações do Richard (bump para a revisão mesclada, primeiro `mark`, `back` de ensaio e flag no launcher), cada uma com rollback; `/pri-pr` em draft.
