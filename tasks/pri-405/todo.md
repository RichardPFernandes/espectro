# PRI-405 · Tarefas

> Plano aprovado pelo Richard em 2026-11-18.

Plano em `plan.md` (regra de troca, PRs e verificação). Cada tarefa roda num subagente opus
novo. Regras de todas: nenhum número real em commit, PR, Linear ou arquivo do repo fora da
própria troca; durações em ms (42000, 45000 nas 6 linhas listadas no plano) não mudam; testes
só com `npm run test:changed` na raiz (nunca `npm test` dentro de `scripts/` ou `dashboard/`);
sem pkill/killall por nome; sem force push; commit com "Refs PRI-405".

- [x] **T0 · Mapa** (base de T1 a T4). Reconstruir o mapa da F0.1/F1.9 a partir de
  `git show --unified=0 dce3118 3f19aa7` (pares ticket → `10001+`, journal → `20001+`) e
  gravar a tabela completa de troca (todos os valores dos testes e prompts → destino pela regra
  do plano) em `~/Workspace/prisma-evidence/PRI-405/mapa.tsv` (fora do repo). Inclui a
  checagem de colisão por arquivo. Prova: o script lista 0 colisões e cobre os 87 valores dos
  testes e os dos prompts. Sem commit no repo.

- [x] **T1 · PR A, testes (AC-01, AC-02).** Branch `RichardPFernandes/pri-405-testes-a` de
  `origin/main`. Aplicar `mapa.tsv` em: `scripts/lib/redmine-hours-sync.test.js`,
  `scripts/invalidate.test.js`, `dashboard/tickets-api.test.js`,
  `dashboard/validity-api.test.js`, `scripts/bitbucket-open-pr.test.js`,
  `scripts/lib/ac-provenance-capture.test.js`, `scripts/lib/spec-authority.test.js`,
  `dashboard/watcher-health-api.test.js`, `scripts/lib/pr-open-cleanup.test.js`,
  `dashboard/redmine-hours-backfill-api.test.js`, `scripts/lib/cycle-notifications.test.js`,
  `scripts/memory-consolidator.test.js`, `scripts/lib/db-effect-pg.test.js`,
  `scripts/lib/pr-status-poll.test.js`, `scripts/lib/watcher-lock.test.js`.
  Teste que falha antes: `git grep -cwE "4[0-9]{4}"` nesses arquivos acha ocorrências; depois,
  zero. `npm run test:changed` verde. `git diff --shortstat` ≤ 400 linhas.

- [x] **T2 · PR B, testes (AC-01, AC-02).** Branch `RichardPFernandes/pri-405-testes-b`.
  Arquivos: `scripts/lib/ac-provenance.test.js`, `scripts/lib/spec-version.test.js`,
  `scripts/invalidate-concurrency.test.js`, `scripts/lib/redmine-ticket-list.test.js`,
  `scripts/lib/spec-template.test.js`, `scripts/effect-authority.test.js`,
  `scripts/lib/review-result.test.js`, `scripts/lib/acceptance-evidence.test.js`,
  `scripts/lib/ac-ids.test.js`, `scripts/lib/authorization.test.js`,
  `scripts/lib/redmine-journal-fetcher.test.js`, `scripts/lib/ac-registry.test.js`,
  `scripts/lib/qa-cycles.test.js`, `dashboard/server.test.js` (sem a duração),
  `dashboard/version-api.test.js`, `scripts/lib/dry-run.test.js`,
  `scripts/lib/spec-generator.test.js`. Mesma prova da T1.

- [x] **T3 · PR C, testes (AC-01, AC-02).** Branch `RichardPFernandes/pri-405-testes-c`.
  Arquivos: `dashboard/authorization-api.test.js`, `dashboard/provenance-api.test.js`,
  `dashboard/redmine-tab-api.test.js`, `scripts/cleanup-runs.test.js`,
  `scripts/lib/qa-handback.test.js`, `scripts/lib/spec-enricher.test.js`,
  `scripts/lib/spec-change.test.js`, `scripts/lib/spec-hash.test.js`,
  `scripts/lib/dom06-attempt.test.js`, `scripts/lib/attachment-downloader.test.js`,
  `dashboard/export-api.test.js`, `scripts/lib/plan-signals.test.js`,
  `scripts/lib/runs-exporter.test.js`, `scripts/lib/qa-diagnosis-content.test.js`,
  `dashboard/system-model.test.js` (sem a duração), `scripts/lib/classifier-guard.test.js`,
  `scripts/lib/knowledge-graph.test.js`, `scripts/lib/spec-validator.test.js`. Mesma prova da
  T1. Ao fim das três, o grep do AC-01 na árvore toda (com A, B e C aplicados juntos numa
  conferência local) só devolve as durações e o hash.

- [ ] **T4 · PR D, prompts (AC-03).** Nesta branch. Em `.claude/commands/commit.md`,
  `fetch-ticket.md` e `plan.md`: trocar os 9 números pelo `mapa.tsv` e o título real do exemplo
  de título de PR por um neutro (`Título do ticket`). Teste que falha antes: depois da troca, o
  AC-29 de `scripts/lib/decomposition-watcher.test.js` falha no `commit.md`; atualizar só o
  hash do `commit.md` e a mensagem/nome do teste (deixa de citar só o 2024597 e passa a citar a
  PRI-405). `implement.md` e `review.md` continuam com o hash antigo. Prova: grep nos prompts
  zero; `npm run test:changed` verde.

- [ ] **T5 · F0.1 concluída (AC-04).** Nesta branch, depois da T4. Em
  `roadmap/fase-0-destravar/FASE.md`: marcar o critério "Estado atual da `main` sem caminho
  pessoal nem número de ticket…", Status da F0.1 `concluída`, coluna da issue com
  `PRI-376, PRI-405 (Médio)`. Condição: PR #198 (README do dashboard) mesclado e PRs A, B e C
  mesclados; senão, fica `em andamento` e o PR D diz o que falta. Prova: `node scripts/lib/roadmap-lint.js`
  sem erro.
