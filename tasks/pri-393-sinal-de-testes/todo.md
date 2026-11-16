# Tarefas PRI-393

Plano: [`plan.md`](plan.md). Comando da suíte: `npm test` (Node 24). Focado: `npm run test:changed`.
Estática: `npm run check`. Toda tarefa começa pelo teste que falha.

## Fase 1 — Base verde (PR 1)

- [ ] **T1: testes de symlink comparam caminho real (AC-01)** · XS
  - Aceite: os dois testes "C0: árvore adversarial" passam no macOS e no Linux.
  - Verificar: `npm test` no Mac sai com 0 nas duas suítes.
  - Arquivos: `scripts/lib/qa-rejection-c0-oracle.test.js`, `scripts/lib/qa-rejection-current-golden.test.js`
  - Depende de: nada

- [ ] **T2: `validate-handoff.test.js` volta para a receita (AC-03)** · S
  - Aceite: o teste não usa `/workspace`; a entrada sai de `harness/test-exclusions.json`; passa na receita.
  - Verificar: `npm test`; o aviso "fora da receita" lista só 2 arquivos.
  - Arquivos: `scripts/validate-handoff.test.js`, `harness/test-exclusions.json`
  - Depende de: nada. Ler antes a regra de `pre-done` sobre caminho temporário.

- [ ] **T3: versão de Node declarada e conferida (AC-02)** · M
  - Aceite: `.nvmrc` (24) e `engines.node` nos três `package.json`; o harness recusa Node abaixo do mínimo com exit 2 e mensagem que diz a versão exigida; README e runbook citam a mesma versão.
  - Verificar: teste novo em `harness/run-tests.test.js`; `nvm use 20 && npm test` sai com 2.
  - Arquivos: `.nvmrc`, `package.json`, `scripts/package.json`, `dashboard/package.json`, `harness/run-tests.js`, `README.md`, `docs/runbook.md`
  - Depende de: nada

- [ ] **T4: CI roda `check:js` e ESLint (AC-05)** · S
  - Aceite: job `static` em Node 24 roda `check:js` de `scripts` e `dashboard` e o `lint:src`; falha se um falhar.
  - Verificar: teste em `harness/` que lê o workflow e exige os três comandos; job verde no PR.
  - Arquivos: `.github/workflows/tests.yml`, `harness/run-tests.test.js`
  - Depende de: nada

### Checkpoint 1

- [ ] `npm test` verde no Mac; job `Tests` verde nas duas versões; job `static` verde.
- [ ] PR 1 em draft com a tabela de evidência (AC-01, AC-02, AC-03, AC-05).
- [ ] Richard revisa antes da fase 2.

## Fase 2 — Checkout intocado (PR 2)

- [ ] **T5: módulo de guarda do checkout, só relatando** · S
  - Aceite: `harness/checkout-guard.js` tira o retrato (caminho, tamanho, data; fora `.git` e `node_modules`) e devolve criados, alterados e apagados; `run-tests.js` imprime a lista sem mudar o exit.
  - Verificar: teste com diretório sintético cobre criar, alterar e apagar; `npm test` mostra os três caminhos conhecidos.
  - Arquivos: `harness/checkout-guard.js`, `harness/checkout-guard.test.js`, `harness/run-tests.js`
  - Depende de: checkpoint 1

- [ ] **T6: log de conflitos vai para o TMPDIR** · S
  - Aceite: o harness define `STATE_CONFLICTS_LOG` dentro do TMPDIR; a suíte não cria `logs/`.
  - Verificar: teste do ambiente do filho em `harness/run-tests.test.js`; a guarda deixa de listar `logs/`.
  - Arquivos: `harness/run-tests.js`, `harness/run-tests.test.js`, `docs/runbook.md`
  - Depende de: T5

- [ ] **T7: testes de build compilam em cópia no TMPDIR** · M
  - Aceite: nenhum teste cria `scripts/dist/` ou `dashboard/dist/`; as asserções atuais continuam.
  - Verificar: apagar `dist/` dos dois pacotes, rodar `npm test`, conferir que não voltam.
  - Arquivos: `scripts/platform-roots.test.js`, `dashboard/platform-roots.test.js`
  - Depende de: T5

- [ ] **T8: guarda passa a falhar (AC-06)** · S
  - Aceite: suíte que cria ou altera arquivo no checkout sai com exit diferente de 0 e lista os caminhos.
  - Verificar: teste com um teste sintético que grava no checkout; `npm test` verde com a guarda ligada.
  - Arquivos: `harness/run-tests.js`, `harness/run-tests.test.js`, `README.md`
  - Depende de: T6, T7 e lista da guarda zerada

### Checkpoint 2

- [ ] `npm test` verde no Mac e na CI com a guarda ligada; `git status --ignored` igual antes e depois.
- [ ] PR 2 em draft com a evidência do AC-06.
- [ ] Richard revisa antes da fase 3.

## Fase 3 — Nada em silêncio (PR 3)

- [ ] **T9: execução estrita no harness (AC-04, parte 1)** · M
  - Aceite: `harness/strict-run.js` recusa arquivo ausente (exit 2, com o nome) e execução com zero testes (exit 1); `run-tests.js` passa a usar o módulo.
  - Verificar: testes com arquivo inexistente e com arquivo sem testes.
  - Arquivos: `harness/strict-run.js`, `harness/strict-run.test.js`, `harness/run-tests.js`
  - Depende de: checkpoint 1

- [ ] **T10: `processo-check` usa a execução estrita (AC-04, parte 2)** · S
  - Aceite: o passo de testes chama `harness/strict-run.js`; o checkout esparso traz `harness`; a lista só tem arquivos que existem nesse checkout.
  - Verificar: teste que lê o workflow e confere cada arquivo contra os caminhos do checkout esparso; log do job mostra a contagem.
  - Arquivos: `.github/workflows/processo-check.yml`, `harness/strict-run.test.js`
  - Depende de: T9

- [ ] **T11: tempo limite de 120 s por teste (AC-08)** · S
  - Aceite: teste que não termina é interrompido e aparece como falha com nome no TAP e em `tap-failures.js`.
  - Verificar: teste sintético com limite curto; `npm test` inteiro verde com 120 s no Mac.
  - Arquivos: `harness/strict-run.js`, `harness/strict-run.test.js`, `harness/tap-failures.test.js`
  - Depende de: T9 (mesmo módulo)

- [ ] **T12: `test:changed` cobre `dashboard/` e avisa o que ficou sem teste (AC-07)** · S
  - Aceite: mudança em qualquer arquivo de `dashboard/` roda a suíte dashboard inteira; arquivo alterado em `scripts/` sem teste par é listado por nome.
  - Verificar: casos novos em `harness/test-changed.test.js` para `dashboard/server.js`, `dashboard/public/views.js` e `scripts/cas.js`.
  - Arquivos: `harness/test-changed.js`, `harness/test-changed.test.js`
  - Depende de: checkpoint 1

### Checkpoint 3

- [ ] Os oito ACs com prova na seção Evidência dos PRs.
- [ ] `npm test`, `npm run check` e os dois workflows verdes.
- [ ] Bloco de Estado da PRI-393 atualizado; pasta `tasks/pri-393-sinal-de-testes/` pode sair depois do merge.
