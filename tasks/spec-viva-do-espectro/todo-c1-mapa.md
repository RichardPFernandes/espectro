# Tarefas C1 (PRI-396)

Plano: [`plan-c1-mapa.md`](plan-c1-mapa.md). Suíte: `npm test` (Node 24). Focado:
`node --test scripts/capability-map.test.js`. Estática: `npm run check`. Toda tarefa de código
começa pelo teste que falha.

## Fase 1 — Script e regras

- [x] **T1: ler cabeçalho e achar o dono de um arquivo (AC-02, AC-06)** · S
  - Aceite: o script lê o cabeçalho de `docs/capacidades/*.md` (escalar, lista em linha, lista em bloco) e recusa campo ausente, valor fora do enum ou forma não suportada; `--of <caminho>` imprime o id e sai 0, ou sai 1 sem dono; `estado.md` existe como primeira capacidade real.
  - Verificar: teste focado verde; `node scripts/capability-map.js --of scripts/cas.js` → `estado`.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`, `docs/capacidades/estado.md`
  - Depende de: nada

- [x] **T2: regras de cobertura e de flag, em casos sintéticos (AC-02, AC-03)** · S
  - Aceite: em diretório temporário, o teste mostra falha com mensagem para arquivo sem dono, arquivo com dois donos, padrão que não casa com nada e flag que não aparece no código da capacidade; `--check` no repo lista quantos arquivos faltam e sai 1.
  - Verificar: teste focado verde; `--check` imprime a contagem.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`
  - Depende de: T1

### Conferência A

- [x] As quatro falhas sintéticas aparecem com arquivo e comando de correção; `npm test` verde.
  - Em 16/11, depois da T2: as quatro falhas aparecem, com arquivo e comando. `--check` no repo:
    faltam 227 de 232 arquivos, sai 1. `npm test` (Node 24): 2 falhas, as mesmas da `main`
    (`/var` e `/private/var` em `qa-rejection-c0-oracle` e `qa-rejection-current-golden`,
    corrigidas na PRI-393, ainda não mesclada). Nenhuma falha do mapa. `npm run check` verde.

## Fase 2 — Classificação

Em cada capacidade: cabeçalho completo, duas a quatro frases, até cinco arquivos por onde
começar, até 40 linhas. Situação e flags conferidas no código; guardar caminho e linha para a
Evidência do PR.

- [x] **T3: base e ciclo — `estado`, `grafo`, `config`, `ciclo-da-run`, `execucao`** · M
  - Aceite: os cinco arquivos existem; `.claude/commands/` e `.graph/` têm dono; nenhum arquivo dessas capacidades casa com dois padrões.
  - Verificar: `--check` mostra a contagem de faltantes caindo e nenhum conflito.
  - Arquivos: `docs/capacidades/{estado,grafo,config,ciclo-da-run,execucao}.md`
  - Depende de: T2
  - Em 16/11: `--check` caiu de 227 para 190 faltantes, 0 com dois donos, 0 padrões sem arquivo, 0 flags fora do código. `.claude/commands/*` e `.graph/` ficam com `grafo` (os dois schemas de outras capacidades, `acceptance-evidence` e `spec-changelog`, ficam em `grafo` e são citados por `portoes` e `spec` na T4). `npm test` (Node 24): as mesmas 2 falhas da `main`; `npm run check` verde.
  - Para o PR: `process-identity` e `node-events` ficaram em `ciclo-da-run` (usados pelo watcher e pelo lease de `estado`); `claude-account`, `sanitize-log` e `agent-exit-signals` em `execucao`. `config` ficou `parcial`: o registro de flags é a F1.1.

- [x] **T4: produto — `spec`, `portoes`, `autorizacao`, `roteamento`, `qa`, `db-effect`, `sdd-writer`** · M
  - Aceite: os sete arquivos existem; `sdd-writer` com `situacao: sem-chamador`; nenhum conflito.
  - Verificar: `--check` sem conflito; contagem de faltantes cai.
  - Arquivos: `docs/capacidades/{spec,portoes,autorizacao,roteamento,qa,db-effect,sdd-writer}.md`
  - Depende de: T2. Pode rodar em paralelo com a T3.
  - Em 16/11: `--check` caiu de 190 para 103 faltantes, 0 com dois donos, 0 padrões sem arquivo, 0 flags fora do código. `npm test` (Node 24): as mesmas 2 falhas da `main`; `npm run check` verde.
  - Para o PR: `dom06-attempt.js` e `git-push-effect.sh` ficaram em `autorizacao` (admissão do Attempt que autoriza efeito externo; dúvida com `estado`). `schema-watcher.js` ficou em `db-effect` e `service-detector.js` em `portoes`, mas `plan-signals.js` os importa. `handoff-lint.js` ficou em `roteamento` junto da flag `WATCHER_PHASE_EFFORT`. Ficaram para a T5: `knowledge-graph.js` e `trace.js`, `maestro-guard-pre-done.js` e `validate-handoff.js`, `prisma-config.js`. As flags lidas só no `readmine-watcher.js` (`SPEC_DRAFT_AUTOGEN`, `SPEC_AUTO_REPAIR`, `WATCHER_QA_DIAGNOSTICO`, `WATCHER_RECUSA_QA_NOVO_CICLO`) estão no corpo, não em `flags`, pela regra do AC-02; o registro delas é a F1.1. `roteamento` ficou `parcial` (`mode: ON` aqui, `decomposition: off`, esforço por fase desligado) e `qa` `parcial` (diagnóstico desligado).

- [x] **T5: bordas e cobertura ligada — `medicao`, `integracoes`, `dashboard`, `ferramentas` (AC-03)** · M
  - Aceite: os quatro arquivos existem; `--check` sai 0 no repo; o teste de cobertura contra o repo real está ligado; a lista do que mudou de capacidade em relação à `PROPOSTA.md` está escrita para o PR.
  - Verificar: teste focado verde; `npm test` verde.
  - Arquivos: `docs/capacidades/{medicao,integracoes,dashboard,ferramentas}.md`, `scripts/capability-map.test.js`
  - Depende de: T3, T4
  - Em 17/11: teste vermelho antes (103 arquivos sem dona), verde depois: `--check` sai 0, 232 de 232 com dona. Dois testes novos contra o repo real (cobertura e as 16 ids). `npm test` (Node 24): as mesmas 2 falhas da `main`; `npm run check` verde. Capacidades de T3/T4 só mudaram em `autorizacao` (+`prisma-config.js`).
  - Para o PR, mudou em relação à `PROPOSTA.md`: (1) `ferramentas` é a 16ª capacidade (decidida em 16/11), com demo, sondas, harness, limpeza (`cleanup-*`), exportadores, `validate-handoff.js` + `maestro-guard-pre-done.js`, `roadmap-lint.js` e o próprio mapa; (2) `dashboard` é `tipo: fluxo` e leva `scripts/preview-manager.js`, `preview-gruntfile.js` e `local-checkout.js`, que só o painel chama; (3) `medicao` leva também `knowledge-graph.js`, `trace.js` e `memory-consolidator.js` (rastreio e padrões do histórico); (4) `integracoes` leva as horas do Redmine e `redmine-journal-fetcher.js` (cliente Redmine da recusa de QA, `qa` fica só com `qa-*`); (5) `prisma-config.js` foi para `autorizacao` (aprovadores e allowlist de bancos).
  - Dúvidas para o PR: `cleanup-runs.js` é chamado pelo watcher ao subir e está em `ferramentas` porque a SPEC mandou "limpeza" para lá; `dashboard/redmine-hours-backfill.js` e `dashboard/obsidian.js` ficam em `dashboard` pelo prefixo `dashboard/*` (um dono por arquivo), mesmo falando de `integracoes` e `ferramentas`.
  - Evidência (caminho:linha, `readmine-watcher.js` salvo indicação): `cost-tracking` e `transcript-writer` importados em 21 e 22, transcrição gravada em 4198 (flag `TRANSCRIPTS_DISABLED` em 4165); `syncKnowledgeGraph` em 5714; `runMemoryConsolidatorSafe` chamado em 5440; `pr-status-poll` em 36; `sweepOpenedPrs` em 6026; `cleanup-runs` em 46 e `DISABLE_AUTO_CLEANUP` em 6136; `PRISMA_DASHBOARD_READONLY` em `dashboard/server.js:925`; `NOTIFY_WEBHOOK_URL` em `scripts/notify.js:23`.

### Conferência B

- [x] `--check` sai 0; as 16 capacidades fecham. Se for preciso criar, fundir ou cortar capacidade, parar e perguntar ao Richard.
  - Em 17/11, depois da T5: fecham as 16 sem criar, fundir nem cortar capacidade; não há pergunta para o Richard aqui.

## Fase 3 — Página de entrada

- [x] **T6: `README.md` do mapa — visão, ciclo da Run e glossário (AC-01, AC-07)** · S
  - Aceite: as quatro seções na ordem da SPEC; diagrama Mermaid com nós, portões e pontos de decisão humana; os 18 termos do glossário presentes; até 150 linhas; "gate" só como nível de revisão. O teste confere seções, termos e teto de linhas, do README e de cada capacidade.
  - Verificar: teste focado verde; ver o diagrama renderizado no GitHub depois do push.
  - Arquivos: `docs/capacidades/README.md`, `scripts/capability-map.test.js`
  - Depende de: T5
  - Em 17/11: teste vermelho antes (sem README), verde depois: 7 casos novos (150 linhas, quatro seções na ordem, visão ≤10 linhas, Mermaid com nós, portões e decisão humana, 18 termos, "gate" só com G0–G3, cada capacidade ≤40 linhas e ≤5 arquivos). README com 86 linhas. `npm test` (Node 24): as mesmas 2 falhas da `main`; `npm run check` verde. Falta ver o diagrama renderizado no GitHub depois do push; a tabela entre os marcadores fica para a T7.

- [ ] **T7: tabela gerada (AC-04)** · S
  - Aceite: `--write` reescreve só o trecho entre os marcadores; rodar duas vezes não muda nada; tabela defasada faz o teste falhar com a instrução de rodar `--write`.
  - Verificar: teste focado verde, com caso sintético de tabela defasada.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`, `docs/capacidades/README.md`
  - Depende de: T6

- [ ] **T8: links relativos (AC-05)** · S
  - Aceite: link relativo para arquivo que não existe, em qualquer arquivo de `docs/capacidades/`, faz o teste falhar citando arquivo e link; links externos e âncoras não são conferidos.
  - Verificar: teste focado verde, com caso sintético de link quebrado.
  - Arquivos: `scripts/capability-map.js`, `scripts/capability-map.test.js`
  - Depende de: T1. Fica aqui porque só tem o que conferir depois da T6.

- [ ] **T9: ponteiros de entrada (AC-08)** · XS
  - Aceite: o `README.md` da raiz, antes do sumário, e o passo 1 do `AGENTS.md` apontam para `docs/capacidades/README.md`; nenhuma outra linha desses arquivos muda.
  - Verificar: `git diff --stat` mostra só as linhas dos ponteiros.
  - Arquivos: `README.md`, `AGENTS.md`
  - Depende de: T6

### Conferência C

- [ ] `npm test` e `npm run check` verdes.
- [ ] Revisão G3 por outro agente Claude em contexto limpo; achados tratados.
- [ ] PR em draft, `Refs PRI-396`, rótulo `processo:medio`, Evidência por AC, com as três perguntas do AC-09 para o Richard.
- [ ] Bloco de Estado da PRI-396 atualizado.
