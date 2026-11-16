# SPEC: PRI-390, tela inicial do dashboard sem FALHOU falso na verificação de UI

> **Status:** v1, proposta (16/11/2026). Nível **Médio**: muda o dashboard e o modo de fixture da
> verificação de UI, atrás de `PRISMA_UI_VERIFY` desligada. Não afeta o consumidor.
> Issue: [PRI-390](https://linear.app/prisma-app/issue/PRI-390). Vem antes do teste da PRI-370.

## Objetivo

Hoje um `/verify-ui` na tela inicial dá **FALHOU** mesmo com o AC atendido. Há duas causas:

1. `index.html` (linhas 8–10) carrega Inter e JetBrains Mono de `fonts.googleapis.com`. O navegador
   da verificação só alcança `127.0.0.1`, então a requisição falha (`REQUEST_FAILED`).
2. `public/obsidian.js` chama `GET /api/obsidian`. Com `PRISMA_OBSIDIAN` desligada (o caso do
   fixture), a rota não existe e responde 404 (`HTTP_ERROR` e `CONSOLE_ERROR`). Esse 404 é o jeito
   que o cliente usa para descobrir que a flag está desligada.

O veredito continua estrito. O que muda é a tela, que deixa de depender de rede e de 404.

## Mudança

- **Fontes locais.** Os `woff2` variáveis (Inter, 400–700; JetBrains Mono, 400–600) vão para
  `dashboard/public/fonts/`, junto com `OFL.txt` e um `README.md` de uma linha por arquivo
  (origem, versão, sha256). Um `fonts.css` com `@font-face` (`font-display: swap`) substitui as
  três linhas do Google no `index.html`. Os tokens `--font-sans` e `--font-mono` ficam iguais.
- **`/api/obsidian` neutra no somente leitura.** No middleware que já neutraliza `/api/claude/usage`
  e `/api/fx` (`server.js` ~l. 961), `GET /api/obsidian` com `PRISMA_DASHBOARD_READONLY=1` responde
  200 `{ enabled: false, vault: null, ready: false, uri: null }`, com a flag ligada ou não. Assim a
  verificação também nunca lê o vault ou as prefs reais. O `obsidian.js` passa a esconder o botão
  quando `enabled === false`. Fora do somente leitura, nada muda: 404 com a flag desligada e
  `state()` com ela ligada.

## Critérios de aceite

- **AC-1** A tela inicial servida pelo fixture não referencia nenhuma origem fora de `localhost`
  ou `127.0.0.1` em `index.html` e nas folhas CSS locais (`href`, `src`, `@import`, `url()`).
  Todo recurso local referenciado responde 200, e as fontes vêm com `font/woff2`.
- **AC-2** Com `PRISMA_DASHBOARD_READONLY=1`, `GET /api/obsidian` responde 200 com o corpo neutro,
  com `PRISMA_OBSIDIAN` em `on` ou em `off`. Sem o modo somente leitura, a resposta é a de hoje
  (404 com a flag desligada, `{vault, ready, uri}` com ela ligada).
- **AC-3** O teste novo `dashboard/ui-fixture-offline.test.js` cobre AC-1 e AC-2 e entra no
  `npm test` do dashboard. O teste da PRI-373 (`obsidian-api.test.js`) continua passando.
- **AC-4** Um `/verify-ui` real na tela inicial (AC de texto visível, não o `<title>`) dá
  **PASSOU**. Um FALHOU forçado (AC com texto que não existe) continua dando **FALHOU**. O
  `verdict.json` dos dois vai na seção Evidência do PR.

## Comandos

```bash
node harness/run-tests.js dashboard ui-fixture-offline.test.js obsidian-api.test.js server.test.js   # foco
(cd dashboard && npm test)                                                                          # suíte do dashboard
PRISMA_UI_VERIFY=on  →  /verify-ui pri-390                                                           # AC-4
```

## Arquivos

`dashboard/public/index.html`, `dashboard/public/fonts/*` (novos), `dashboard/public/obsidian.js`,
`dashboard/server.js`, `dashboard/ui-fixture-offline.test.js` (novo), `dashboard/package.json`
(lista de testes), `docs/ui-verify.md` (uma linha: a tela não pode depender de rede).

## Limites

- **Sempre:** o veredito fica como está; teste antes do commit; PR em draft com "Refs PRI-390".
- **Perguntar antes:** mudar CI; adicionar dependência npm (ex.: `@fontsource/*`); mudar as regras
  do `verdict` (`REQUEST_FAILED`, `HTTP_ERROR`, `CONSOLE_ERROR`).
- **Nunca:** ligar `PRISMA_UI_VERIFY` ou `PRISMA_OBSIDIAN` em consumidor; dar ao navegador da
  verificação acesso a outra origem.

## Decisões (com recomendação)

- **D1 — Origem das fontes.** *Recomendo* os `woff2` das releases oficiais (Inter em
  `rsms/inter`, JetBrains Mono em `JetBrains/JetBrainsMono`), versão fixa e sha256 no README. Os dois
  usam a licença OFL 1.1, que permite redistribuir. Alternativas: (b) pacote `@fontsource`, que é
  dependência nova; (c) só fontes do sistema, que muda o visual.
- **D2 — Forma da resposta neutra.** *Recomendo* 200 com `enabled: false` e o cliente lendo o campo.
  Alternativa: 204 sem corpo. Funciona porque o `r.json()` falha em silêncio, mas é frágil.
