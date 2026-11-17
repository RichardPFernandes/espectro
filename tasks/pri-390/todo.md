# Tarefas: PRI-390

> Fonte: [SPEC](SPEC.md) e [plano](plan.md). TDD: o teste nasce falhando. Comando focado:
> `node harness/run-tests.js dashboard <arquivo>.test.js`.

- [x] **T1: `/api/obsidian` neutra no modo de fixture** (AC-2) — feita: RED nos testes novos, verde depois; suíte do dashboard 569/569
  - Aceite: com `PRISMA_DASHBOARD_READONLY=1`, a resposta é 200 `{enabled:false, vault:null, ready:false, uri:null}` com `PRISMA_OBSIDIAN` `on` e `off`. Sem o modo, o comportamento é o de hoje (404 desligada; `state()` ligada). O botão fica escondido com `enabled:false` e aparece com o estado normal.
  - Verificar: `node harness/run-tests.js dashboard obsidian-api.test.js server.test.js`
  - Arquivos: `dashboard/server.js`, `dashboard/public/obsidian.js`, `dashboard/obsidian-api.test.js`

- [x] **T2: Fontes locais** (parte de AC-1) — feita: RED nos 4 testes novos, verde depois; suíte do dashboard 573/573; `curl -sI` dá `font/woff2` nas quatro fontes. JetBrains Mono em três pesos estáticos (400/500/600), porque a release não traz `woff2` variável. A conferência a olho fica para a T4, porque não havia navegador nesta sessão
  - Aceite: as linhas do Google saíram do `index.html`. `public/fonts/` tem os `woff2` variáveis, `OFL.txt`, um README com URL, versão e sha256, e `fonts.css`. O static serve `font/woff2`. A tela fica igual a olho.
  - Verificar: `shasum -a 256 dashboard/public/fonts/*.woff2` bate com o README; `curl -sI localhost:<porta>/fonts/<arquivo>.woff2`; olhar a tela.
  - Arquivos: `dashboard/public/index.html`, `dashboard/public/fonts/*`

- [x] **Checagem A:** `(cd dashboard && npm test)` verde (573/573).

- [x] **T3: Teste do fixture offline** (AC-1, AC-3) — feita: 4 testes novos (varredura com autoteste das linhas do `main`, varredura de disco, 200 de todo recurso a partir de `/`, `/api/obsidian` neutra com flag on/off/ausente). Sensibilidade provada: com o `index.html` do `main`, a varredura reprova as 3 origens do Google; com um `<link>` local inexistente, o teste dos 200 reprova com 404
  - Já existe: a T2 criou o arquivo com os testes das fontes e o registrou no `npm test`. A T3 acrescenta a varredura genérica (a), os 200 de todo recurso local (b) e o `/api/obsidian` neutro (c).
  - Aceite: `ui-fixture-offline.test.js` reprova uma origem externa em HTML ou CSS, exige 200 em todo recurso local e `font/woff2` nas fontes, e confere `/api/obsidian` neutra. Está registrado no `npm test`. Falha com o `index.html` do `main`.
  - Verificar: `node harness/run-tests.js dashboard ui-fixture-offline.test.js`; para ver a falha, apontar a parte (a) do teste para o `index.html` do `main` (`git show main:dashboard/public/index.html > <scratchpad>/index.html`), sem stash.
  - Arquivos: `dashboard/ui-fixture-offline.test.js`, `dashboard/package.json`

- [x] **Checagem B:** `(cd dashboard && npm test)` verde (577/577), `check:js` limpo, e o teste novo provadamente sensível.

- [x] **T4: `/verify-ui` real e PR** (AC-4) — feita: PASSOU (71 requisições 200, 0 erro de console, fontes locais) e FALHOU forçado (`ELEMENT_MISSING`); vereditos em `~/Workspace/prisma-evidence/pri-390/`; fontes conferidas a olho no screenshot
  - Aceite: com AC de texto visível, a tela inicial dá PASSOU; com AC de texto inexistente, dá FALHOU. Os dois `verdict.json` ficam em `~/Workspace/prisma-evidence/pri-390/` e são citados no PR. `docs/ui-verify.md` ganhou uma linha. PR em draft com `processo:medio` e "Refs PRI-390". Revisão G3 feita, sem MAJOR aberto.
  - Verificar: `PRISMA_UI_VERIFY=on` → `/verify-ui pri-390` (duas vezes); `processo-check` verde no PR.
  - Arquivos: `docs/ui-verify.md`, descrição do PR
