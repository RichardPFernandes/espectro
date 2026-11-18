# F1.5 segundo PR: tarefas (PRI-381, Médio)

Cada tarefa roda num subagente novo (opus), com TDD: o teste falha antes, passa depois.
Testes: `npm run test:changed -- origin/main` na raiz, com Node 22 ou mais.

- [ ] **T1. Flag e funções puras.** AC-04, AC-05.
  Registrar `WATCHER_CLI_RESULT_JSON` (desligada, issue PRI-381, data de decisão) em
  `docs/flags.md` e no `.env.example`. Criar `scripts/lib/cli-result.js` com:
  - `cliResultJsonEnabled(env)` (só `on` liga; valor inválido é erro, como as outras flags);
  - `parseCliResult(text, sessionId)` (procura, de trás para frente, a linha com o objeto
    `type: "result"` desse `session_id`, aceitando o prefixo `[claude] `, e devolve
    `{ cost_usd, usage, model_usage, num_turns }` ou `null`);
  - `cliVersionFromTranscript(contents)` (último `version` não vazio, senão `null`);
  - `promptHashes(root, nodes)` (`{ nó: sha256 | 'UNKNOWN' }`).
  Rodar `node --test scripts/capability-map.test.js` e seguir a mensagem.
  Teste: `scripts/lib/cli-result.test.js`, com fixtures sintéticas, incluindo JSON
  ilegível, `session_id` de outra sessão e template ausente.

- [ ] **T2. Argv do despacho.** AC-04.
  Em `dispatchClaudeSegment` (`scripts/readmine-watcher.js`), com a flag ligada, acrescentar
  `--output-format json`. Teste golden: com a flag desligada, o argv é idêntico ao atual. Teste
  de que `looksUnavailable`, `looksLikeSessionLimit` e `operationalCause` detectam o mesmo
  texto quando ele vem dentro do JSON da CLI.

- [ ] **T3. Gravação no run.** AC-04, AC-05.
  - `startCostRun` grava `cli_result_json`, `log_offset` e `prompt_hashes`, só com a flag
    ligada.
  - `collectRunMetrics` lê o JSON (de `result.output` com `--follow`, ou do log a partir do
    `log_offset`) e a versão do transcript.
  - `costTracking.mergeRun` e `attemptRecord` gravam `cost.cli_usd`, `cli_version` e
    `prompt_hashes` no Attempt, e `cli_cost_usd` e `runs_without_cli_cost` no nó e nos totais.
  - Atualizar `.graph/schemas/state.schema.json`.

  Testes:
  - flag desligada: o `cost_tracking` fica byte a byte igual ao de hoje;
  - flag ligada: os campos aparecem;
  - JSON ausente: `cli_usd` fica `null` e `runs_without_cli_cost` sobe;
  - o state gravado valida no schema.

- [ ] **T4. Weekly.** AC-04, AC-05.
  Em `dashboard/public/weekly-report.js`:
  - o USD do run vem de `totals.cli_cost_usd` quando nenhum nó tem `runs_without_cli_cost`, e
    senão do transcript;
  - trocar `COST_SOURCE` pela contagem por fonte e a diferença somada;
  - trocar `CONFIG_UNKNOWN` pelas versões da CLI e pelos hashes distintos na janela (8
    caracteres), com "+N desconhecido";
  - mesmas linhas na tela e no "Copiar resumo".

  Testes em `dashboard/weekly-report.test.js`:
  - run só com transcript;
  - run com as duas fontes (diferença certa);
  - run misto (a fonte cai para o transcript);
  - nada gravado (desconhecido, nunca zero).

- [ ] **T5. Ponta a ponta e docs.** AC-04, AC-05.
  - Teste sintético: um despacho com a flag ligada e `SIMULATE` desligado não é viável; use
    um log e um transcript de fixture e passe pelo `finishCostRun` e pelo `buildReport`.
  - Atualizar `dashboard/README.md`.
  - Atualizar `docs/flags.md`, com critério de ligar e de desligar e o risco do log mudo.
  - Atualizar `roadmap/ACOMPANHAMENTO.md` (métrica 1: fonte do custo).
