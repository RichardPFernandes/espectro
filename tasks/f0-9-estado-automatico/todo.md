> Plano aprovado pelo Richard em 2026-11-18.

# Tarefas PRI-399 (AC-03)

Contexto para cada subagente: leia `tasks/f0-9-estado-automatico/plan.md`. Nível Médio.
Nenhum dado do consumidor em teste ou fixture (use marcadores, como `90003-...`).

- [x] **T1: leitor do registro de flags por processo (AC-03, métrica 4)** · S
  - O que: função pura `summarizeFlags(rows, today)` em `scripts/lib/flag-registry.js` e o
    script `scripts/flags-read.js --json`, que lê `docs/flags.md` (caminho a partir do
    `__dirname`) e imprime `{ ok: true, summary }` ou `{ ok: false, error }`. `summary`:
    `n` (linhas), `padrao` {ligada, desligada}, `consumidor` {nao_verificado, outro},
    `vencidas` (Decidir até < hoje, UTC), `itens_desligados` (coluna = `sim`),
    `fonte: "docs/flags.md"`, `hoje`.
  - Teste que falha antes: `scripts/lib/flag-registry.test.js` (ou `scripts/flags-read.test.js`)
    com markdown de fixture e `today` fixo: contagens certas, uma linha vencida, tabela
    quebrada → `ok:false`, nunca zero.
  - Arquivos: `scripts/lib/flag-registry.js`, `scripts/flags-read.js`, teste.
  - Depende de: nada

- [x] **T2: rota `GET /api/flags-summary` no dashboard (AC-03, métrica 4)** · S
  - O que: o servidor chama `scripts/flags-read.js` por `execFile` (opção
    `flagsReadScript` para teste, como `effortMissReadScript`), devolve o `summary`; falha →
    502 `{ status: "UNKNOWN" }` sem vazar caminho. Só leitura.
  - Teste que falha antes: `dashboard/flags-summary-api.test.js`: 200 com `n` igual ao número
    de linhas do `docs/flags.md`; script quebrado → 502 UNKNOWN; POST/PUT/DELETE → 404/405;
    o dashboard não importa `scripts/lib/flag-registry` (fronteira G3).
  - Arquivos: `dashboard/server.js`, `dashboard/flags-summary-api.test.js`.
  - Depende de: T1

- [x] **T3: modelo das cinco métricas no relatório (AC-03)** · S
  - O que: `fiveMetrics(M, flags)` em `dashboard/public/weekly-report.js` (exportada), cinco
    linhas `{ id, nome, valor, n, fonte, conhecida }`: M1 de `M.perTicket` + `M.costSource`;
    M2 de `M.cur.firstPass`/`firstPassRuns` + soma de `M.baseline` (USD imputado, +N
    desconhecido); M3 sempre desconhecido (F1.3/F3.4); M4 do `flags` (null → desconhecido);
    M5 desconhecido (Linear, à mão). E `seriesRow(metrics, semana)`: a linha com as colunas
    da série do `ACOMPANHAMENTO.md`, "sem medição" onde não há dado.
  - Teste que falha antes: em `dashboard/weekly-report.test.js`: sem runs e sem flags → as
    cinco desconhecidas, nenhum "0"; com fixture → valores, `n =` e fonte em todas; a linha
    da série tem 7 colunas.
  - Arquivos: `dashboard/public/weekly-report.js`, `dashboard/weekly-report.test.js`.
  - Depende de: nada (usa o formato do `summary` de T1)

## Checkpoint: depois de T1–T3
- [x] `npm run test:changed` verde; `node scripts/lib/flag-registry.test.js` verde

- [ ] **T4: tela, "Copiar resumo" e docs (AC-03)** · M
  - O que: seção "As cinco métricas do acompanhamento" no topo da capa (aba Resumo), uma
    linha por métrica com valor, n e fonte; desconhecido com a classe `wr-none`. O front
    busca `/api/flags-summary` ao abrir o relatório e no ↻ (como `loadPatterns`); erro →
    M4 desconhecida. O `copyText` ganha o bloco das cinco métricas e a "Linha para a série"
    vira a `seriesRow`. Docs: seção do relatório no `dashboard/README.md`; coluna "Onde já é
    medida" das métricas 4 e o rito no `roadmap/ACOMPANHAMENTO.md`; spec viva
    `docs/capacidades/medicao.md` se ela citar o relatório.
  - Teste que falha antes: `copyText` traz as cinco linhas, cada uma com `n =` e `fonte:`;
    render da capa com as cinco (teste de UI existente do weekly, se houver harness).
  - Arquivos: `dashboard/public/weekly-report.js`, `dashboard/public/screens/weekly-report.css`,
    `dashboard/weekly-report.test.js`, `dashboard/README.md`, `roadmap/ACOMPANHAMENTO.md`.
  - Depende de: T2, T3

## Checkpoint: completo
- [ ] `npm test` e `npm run check` verdes (`/pri-check`)
- [ ] Relatório com `DRY_RUN` mostra as cinco métricas; texto copiado vai para a Evidência
