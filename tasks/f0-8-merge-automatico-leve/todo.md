> Plano aprovado pelo Richard em 2026-11-18.

# Tarefas PRI-410 (F0.8, Alto)

Contexto comum para cada subagente: leia `tasks/f0-8-merge-automatico-leve/SPEC.md` (seções Decisões e Critérios de aceite) e `plan.md`. Os testes de `.github/` rodam com `node --test .github/scripts/*.test.mjs`, a partir da raiz; o `npm run test:changed` não cobre essa pasta. Não grave `MERGE_LEVE`, não mude configuração do repo, ruleset nem workflow existente fora da tarefa.

- [x] **T1: função de elegibilidade e lista `mergeLeve` (AC-01, AC-02, AC-05)** · M
  - Fazer: acrescentar a chave `mergeLeve` em `.github/processo.json`, com a lista exata do item (b) da SPEC (`allowedPaths`, `deniedPaths`; remoção e renomeação só para `.md`) e `requiredChecks: ["Node 22", "Node 24", "processo-check"]`. Criar `.github/scripts/merge-leve-lib.mjs` com:
    - `pathVerdict(files, cfg)`: devolve `{ ok, motivos[] }`; a negação vence; `removed` e `renamed` só valem para `.md` (no renomeado, o nome antigo também precisa estar na lista).
    - `evaluatePr({ pr, files, checks, config, repo })`: devolve `{ merge: boolean, motivos[] }`. Exige exatamente um rótulo de nível, e ele `processo:leve`; `draft === false`; `head.repo.full_name === repo` (sem fork); `base.ref === 'main'`; `state === 'open'`; caminhos ok; os `requiredChecks` presentes; e todo check-run e status do `head.sha` concluído com `success`, `neutral` ou `skipped`.
    - Reusar `matchesAny` e `loadConfig` de `processo-lib.mjs`.
  - Teste que falha antes: `.github/scripts/merge-leve.test.mjs`. Casos: só `docs/x.md` elegível; `scripts/a.js` fora (AC-02); `docs/flags.md` e `.github/processo.json` negados; teste removido fora; `.md` removido ok; draft, fork, check pendente, check vermelho, check obrigatório ausente e dois rótulos de nível não mesclam (AC-05). AC-01: chamar com `config` da base, sem `docs/novo/**`, e um PR que acrescenta `docs/novo/**` à própria lista e toca `tasks/x.json` → não mescla; a função não lê nada do PR além de `files`.
  - Arquivos: `.github/processo.json`, `.github/scripts/merge-leve-lib.mjs`, `.github/scripts/merge-leve.test.mjs`
  - Depende de: nada

- [x] **T2: CLI de merge com simulação (AC-04, AC-01, AC-02)** · M
  - Fazer: `.github/scripts/merge-leve.mjs`, exportando `run({ event, env, gh, config, log, summary })`, mais um `main()` que monta `gh` com `fetch` e `GITHUB_TOKEN`.
    - Os PRs vêm de `event.workflow_run.pull_requests`; se a lista vier vazia, de `GET /repos/{r}/commits/{head_sha}/pulls`.
    - Para cada PR aberto: busca o PR atual, os arquivos (paginados, como em `processo-check.mjs`), os check-runs e os status do `head.sha`; avalia com `evaluatePr` usando o `config` do checkout local (a `main`).
    - Com `env.MERGE_LEVE === 'on'` e elegível: `PUT /repos/{r}/pulls/{n}/merge` com `{ merge_method: 'squash', sha: head.sha }`. Resposta 405 ou 409 é registrada como "mudou, fica para a próxima rodada", sem erro. Depois do merge, se algum arquivo casa `ROADMAP.md` ou `roadmap/**`: `POST /repos/{r}/actions/workflows/roadmap-pages.yml/dispatches` com `{ ref: 'main' }`.
    - Sem `on`: só escreve `mesclaria #N` ou `não #N: <motivos>`.
    - Toda saída vai para `GITHUB_STEP_SUMMARY`, escapando o que vem do PR (como em `processo-check.mjs`).
  - Teste que falha antes: em `.github/scripts/merge-leve-cli.test.mjs`, um `gh` falso que registra as chamadas. Sem `MERGE_LEVE`, um PR elegível não gera `PUT` e o resumo diz "mesclaria" (AC-04). Com `on`, gera um `PUT` com o `sha` certo. PR com `scripts/` não gera `PUT` nem com `on` (AC-02). 409 não lança erro. Roadmap dispara o dispatch; só docs não dispara.
  - Arquivos: `.github/scripts/merge-leve.mjs`, `.github/scripts/merge-leve-cli.test.mjs`
  - Depende de: T1

- [x] **T3: workflow `merge-leve.yml` (AC-01, AC-04; item c da SPEC)** · S
  - Fazer: `.github/workflows/merge-leve.yml`.
    - `on: workflow_run`, com `workflows: [Tests, processo-check]` e `types: [completed]`. Sem `pull_request_target` e sem `workflow_dispatch`.
    - `permissions: {}` no topo. No job: `contents: write`, `pull-requests: write`, `actions: write`, `checks: read`, `statuses: read`.
    - `if: github.event.workflow_run.event == 'pull_request'`.
    - `concurrency: merge-leve-${{ github.event.workflow_run.head_sha }}`.
    - Checkout esparso de `/.github/` sem `ref` (a `main`), com `persist-credentials: false` e as mesmas versões fixadas por SHA dos outros workflows.
    - Passo `node .github/scripts/merge-leve.mjs`, com `GITHUB_TOKEN` e `MERGE_LEVE: ${{ vars.MERGE_LEVE }}`.
  - Teste que falha antes: em `.github/scripts/merge-leve-workflow.test.mjs`, leitura do YAML como texto (sem dependência nova). Confere: `workflow_run` presente; `pull_request_target`, `workflow_dispatch` e `head_sha`/`head_branch` como `ref:` de checkout ausentes; `permissions: {}` no topo; `persist-credentials: false`; todo `uses:` fixado por SHA de 40 caracteres; `vars.MERGE_LEVE` passado.
  - Arquivos: `.github/workflows/merge-leve.yml`, `.github/scripts/merge-leve-workflow.test.mjs`
  - Depende de: T2

- [x] **Ponto de controle (depois de T3):** `node --test .github/scripts/*.test.mjs` verde; merge em simulação coberto de ponta a ponta pelo teste do T2.

- [x] **T4: resumo diário na issue fixa (AC-03)** · M
  - Fazer: em `merge-leve-lib.mjs`, `buildDailySummary({ merged, skipped, date })` devolve markdown, ou `null` quando as duas listas estão vazias. `.github/scripts/merge-leve-resumo.mjs` exporta `run({ env, gh, config, now })`:
    - `merged`: PRs fechados nas últimas 24 h com `merged_by.login === 'github-actions[bot]'` (número, título, `PRI-NNN` tirado do título).
    - `skipped`: PRs abertos com `processo:leve` e fora de draft que `evaluatePr` recusa, com os motivos.
    - Procura a issue aberta com o título exato "Merge automático do Leve: resumo" e a cria se não houver; comenta só quando o resumo não é `null`.
    - Workflow `.github/workflows/merge-leve-resumo.yml`: `schedule: cron '0 11 * * *'` (08:00 BRT) e `workflow_dispatch` com `if: github.ref == 'refs/heads/main'`; `permissions: {}` no topo e, no job, `issues: write`, `pull-requests: read`, `checks: read`, `statuses: read`; mesmo checkout esparso da `main`.
  - Teste que falha antes: em `.github/scripts/merge-leve-resumo.test.mjs`, com o `gh` falso. Um PR mesclado pelo bot aparece no comentário; um PR mesclado por outra pessoa não aparece; dia vazio não comenta; sem a issue, ela é criada uma vez; um Leve fora da lista aparece em "ficou de fora" com o motivo. O teste do T3 passa a cobrir também este workflow (as mesmas regras de YAML).
  - Arquivos: `.github/scripts/merge-leve-lib.mjs`, `.github/scripts/merge-leve-resumo.mjs`, `.github/scripts/merge-leve-resumo.test.mjs`, `.github/workflows/merge-leve-resumo.yml`, `.github/scripts/merge-leve-workflow.test.mjs`
  - Depende de: T1 (e T3, pelo teste de workflow)

- [x] **T5: `/pri-pr` abre fora de draft só o Leve elegível (AC-06)** · S
  - Fazer: em `merge-leve.mjs`, um modo local `--paths <arquivo name-status> --config <arquivo>` que imprime `elegível` ou `draft: <motivos>` usando só `pathVerdict` (código de saída 0 nos dois casos; 2 em erro de execução). Em `.claude/skills/pri-pr/SKILL.md`:
    - Passo 5: no Leve, rodar `git diff -M --name-status origin/main...HEAD > <scratch>/ns.txt`, `git show origin/main:.github/processo.json > <scratch>/cfg.json` e o modo `--paths`. Se der `elegível`, `gh pr create` sem `--draft`; senão, com `--draft`. Médio e Alto sempre em `--draft`.
    - Passo 8: "nunca marque como ready" vale para o PR que nasceu em draft. Para segurar um Leve elegível, o agente ou o Richard converte para draft (`gh pr ready --undo <n>`).
    - Passo 7: no Leve fora de draft, o Próximo passo é "merge automático pelo bot ou Richard".
  - Teste que falha antes: em `merge-leve-cli.test.mjs`, o modo `--paths` com só `docs/a.md` imprime `elegível`; com `scripts/a.js`, imprime `draft:` e o motivo. O `skills-flag.test.mjs` segue verde.
  - Arquivos: `.github/scripts/merge-leve.mjs`, `.github/scripts/merge-leve-cli.test.mjs`, `.claude/skills/pri-pr/SKILL.md`
  - Depende de: T2

- [x] **T6: texto da exceção e linha do roadmap (item a da SPEC)** · XS, só texto
  - Fazer:
    - Regra 10 do `CLAUDE.md` e a linha "PR sempre em draft…" de "O que nunca muda" no `AGENTS.md`, com o texto exato do item (a) da SPEC, incluindo o draft como trava.
    - `docs/fluxo-dev.md`: o nó do `/pri-pr` diz "PR draft, ou pronto no Leve elegível".
    - `roadmap/fase-0-destravar/FASE.md:41`: Status `em andamento` e Issue `PRI-410`.
  - Verificar: `node scripts/lib/roadmap-lint.js` com 0 erro; `node --test .github/scripts/*.test.mjs .claude/hooks/*.test.mjs` verde.
  - Arquivos: `CLAUDE.md`, `AGENTS.md`, `docs/fluxo-dev.md`, `roadmap/fase-0-destravar/FASE.md`
  - Depende de: nada

- [ ] **Ponto de controle final:** `/pri-check` (`npm test` e `npm run check` na raiz, mais dois revisores em contexto limpo, por ser Alto) e, depois, a parte "Pedido" do `/pri-autorizo` antes do `/pri-pr`.
