# F1.5, segundo PR: custo pelo JSON da CLI e configuração por run (PRI-381)

Nível Médio (D-PRI-381-01, opção A, aprovada em 17/11/2026). Entra o AC-04 e a gravação do
AC-05. O AC-01, o AC-02 e a leitura do AC-05 já estão na `main` (PR #193).

## Desenho

- **Flag** `WATCHER_CLI_RESULT_JSON`, desligada. Registrada em `docs/flags.md` e no
  `.env.example`. Desligada: o argv do despacho, o log e o `cost_tracking` ficam idênticos aos
  de hoje (teste golden). Ligar no consumidor é Alto, com AUTORIZO próprio, fora deste PR.
- **Despacho (ligada).** `dispatchClaudeSegment` acrescenta `--output-format json`. A CLI
  devolve um objeto `type: "result"` com `total_cost_usd`, `usage`, `modelUsage` e
  `session_id`. Ele cai no log do ticket como as linhas de hoje.
- **Run pendente (ligada).** `startCostRun` grava `cli_result_json: true`, o tamanho do log
  no início (`log_offset`) e `prompt_hashes`: para cada nó do despacho, o sha256 do template
  `${PRISMA_ROOT}/.claude/commands/<nó>.md` (com `fetch_ticket` virando `fetch-ticket`).
  Template ausente vira `UNKNOWN`.
- **Fechamento (ligada).** `collectRunMetrics` lê o JSON da CLI. Com `--follow`, ele vem de
  `result.output`; sem `--follow`, vem do log a partir do `log_offset`, na linha com o mesmo
  `session_id`. A versão da CLI vem do campo `version` do transcript da sessão, que é a
  versão que de fato rodou e não exige processo novo. JSON ausente ou ilegível vira `null`
  (reserva: o transcript), nunca zero.
- **Registro.** O Attempt ganha `cost.cli_usd`, `cli_version` e `prompt_hashes`. O nó ganha
  `cli_cost_usd` e `runs_without_cli_cost`; os totais ganham `cli_cost_usd`. `cost_usd` segue
  sendo o do transcript, então nada que lê o campo hoje muda. Schema em
  `.graph/schemas/state.schema.json`.
- **Weekly.** O USD do run vem do JSON da CLI quando todos os nós o têm e, senão, do
  transcript. O relatório diz quantos runs usaram cada fonte e a diferença (CLI menos
  transcript) somada nos runs com as duas. Versão da CLI e hash dos prompts saem distintos
  na janela, com contagem de "desconhecido".
- **Código novo** em `scripts/lib/cli-result.js` (funções puras: ler o JSON, achar a versão
  no transcript, hash dos templates), com capacidade dona pelo `capability-map.test.js`.

## Riscos

- Com a flag ligada, o log do ticket deixa de mostrar o texto do agente durante o nó: só o
  JSON no fim. O agent-log do dashboard fica mudo até a saída. Fica no "Fica ligado?" do PR e
  no critério de ligar em `docs/flags.md`.
- `looksUnavailable`, `looksLikeSessionLimit` e `operationalCause` procuram texto na saída. Com
  JSON, o texto vem dentro de `result`, entre aspas. A T2 prova com teste que continuam
  detectando.
- O redator de secrets pode alterar o JSON no log. Se a linha não fizer parse, o custo da CLI
  fica `null`, e a reserva é o transcript.

## Demonstração

Teste ponta a ponta com fixture sintética: um despacho simulado com a flag ligada grava um log
com o JSON da CLI e um transcript com `version`. O fechamento grava `cli_usd`, `cli_version` e
`prompt_hashes`, e o weekly mostra a fonte e a diferença. Nada roda no consumidor.
