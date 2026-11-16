# SPEC: PRI-354, esforço fixo por fase ligado no piloto (N=10)

> **Status:** v1, **aceita pelo Richard em 15/11/2026** (D1–D4 como recomendadas). Nível **Alto** (liga flag no consumidor).
> Issue: [PRI-354](https://linear.app/prisma-app/issue/PRI-354), filha da PRI-352. Base: PR #144
> (PRI-353, `tasks/effort-por-fase/SPEC.md`, D1–D8 aprovadas em 14/11/2026). Bloqueios: merge do
> #144 e PRI-336. Nada liga sem o AUTORIZO próprio desta issue.

## Contexto

A PRI-353 deixou pronto, atrás de flags desligadas, o esforço por fase no argv
(`WATCHER_PHASE_EFFORT`), o handoff das fases em esforço alto, o registro `effort_miss` e o
benchmark offline. Do AC5 ficou só o argv do segmento `[plan, implement]`
(`WATCHER_PLAN_IMPLEMENT_CHAIN`). O despachante que monta o segmento ficou para esta issue.
O consumidor natural do piloto é o Espectro, que já roda o piloto de roteamento da PRI-341
(`mode: ON`, policy `routing-pri205@p2-pilot-2026-11-16`, 3 runs de baseline).

## Escopo

1. **Despachante do segmento `[plan, implement]`** (atrás de `WATCHER_PLAN_IMPLEMENT_CHAIN`,
   desligada). O segmento entra no lugar do plan avulso só quando **todas** as condições valem:
   flag ligada; nó `plan`; nenhum `implement` no histórico (primeiro ciclo); run sem roteamento
   ON e sem decomposição; `SKIP_PRE_BUILD_VALIDATION=true`. Fora disso, o despacho segue por nó,
   byte a byte.
   - **Portões entre plan e implement:**
     - O plan-scorer roda dentro da sessão, entre `/plan` e `/implement`, pelo CLI que já existe
       (`scripts/lib/plan-scorer.js`). Saída 1 = o agente não roda o `/implement` e para. O
       próximo tick cai no `runPlanGate` de sempre (re-plan ou escalada). É o mesmo padrão do
       `spec-validator` no segmento `fetch_ticket+plan`.
     - O pré-build não roda no segmento: a condição de entrada exige o skip.
     - A âncora de churn é gravada antes do segmento. O plan só escreve em `memory/`, então a
       âncora é a mesma.
     - O drift de spec não é conferido antes do implement. Ele é conferido de novo antes do
       review: se houver drift, perde-se o trabalho do implement, mas nada é corrompido.
   - **Lease:** um lease com `nodes: [plan, implement]`, `node_started_at` único.
   - **Admissão DOM06:** dois Attempts admitidos antes do spawn, um por nó. Se o do implement não
     for admitido, o plan sai avulso. Na saída, a decisão só vale se o `state.json` for deste
     despacho (claim do release e `node_started_at`). O plan concluiu se o implement rodou ou se
     o `/plan` avançou `state.node`; concluído, o Attempt do plan fecha com 0 mesmo se a sessão
     caiu depois. O do implement fecha pelo código de saída só se o implement rodou
     (`implement` no histórico, que no despacho não tinha nenhum) **e** o plano passa de novo no
     scorer na saída. Nos demais casos é revogado, nunca contado como PASS:
     `CHAIN_STOPPED_AFTER_PLAN` (scorer reprovou, saída 0), `CHAIN_IMPLEMENT_NOT_CONFIRMED`
     (plan concluído, sessão caiu), `CHAIN_PLAN_NOT_DONE`, `CHAIN_CLAIM_LOST`,
     `CHAIN_STATE_UNREADABLE`, `CHAIN_PLAN_GATE_FAILED` e `CHAIN_PLAN_GATE_UNKNOWN`.
   - **Eventos:** `node_start` do plan no despacho. Na saída, `node_end` só dos nós que de fato
     rodaram. Plan concluído e sessão caída: `node_end` do plan e `node_error` do implement. O
     `node_start` do implement usa o ts do segmento, com a nota de que o início exato é UNKNOWN.
2. **Benchmark (MINOR 3–6 da G3 da PRI-353):**
   - O nível por fase vem do `phase_effort` gravado nas runs, não da tabela `latest`.
   - Medição parcial vira UNKNOWN: `runs_without_tokens > 0`, ou Attempt sem `duration_ms`.
   - O Δ é a mediana das diferenças por par, só entre pares medidos dos dois lados.
   - `--out` é conferido por realpath.
3. **Piloto (só com AUTORIZO):** liga `WATCHER_PHASE_EFFORT=1` no launcher do watcher do piloto,
   faz o readback, roda 10 pares e gera a página do benchmark a partir da medição real.

## Critérios de aceite

- **AC1.** Com `WATCHER_PLAN_IMPLEMENT_CHAIN` desligada, o argv e os eventos do plan são iguais
  ao golden atual.
- **AC2.** Com ela ligada e as condições valendo, um único `claude -p` recebe
  `/plan → plan-scorer → /implement`, sem o bloqueio de subagente. Faltando qualquer condição, o
  despacho sai avulso (um teste por condição).
- **AC3.** Lease, DOM06 e eventos registram os dois nós. Plano reprovado no scorer revoga o
  Attempt do implement e não emite `node_end` do implement.
- **AC4.** O segmento roda de ponta a ponta no despacho real do watcher com o `claude` falso
  (`plan-implement-chain-watcher.test.js`), nos dois desfechos: plano reprovado e plan+implement
  concluídos. (Ajuste da v1: o `--dry-run` não exercita o segmento, porque a spec simulada fica
  fora de `memory/spec/` e a task nova roda o plan dentro do `fetch_ticket+plan`.)
- **AC5.** No benchmark: o nível vem da run; medição parcial dá UNKNOWN; o Δ é pareado; `--out`
  por symlink para dentro de uma run é recusado.
- **AC6.** Com o AUTORIZO: flag ligada só no piloto, readback no PR e 10 pares concluídos (D3).
  A página sai da medição real, com UNKNOWN onde faltar medição.
- **AC7.** Recomendação entregue e decisão do Richard registrada na issue.

## Suposições

1. Piloto = Espectro (este repo como consumidor, `REPO_PATH` aqui), tracker Redmine, como na PRI-341.
2. "Ligar" = variável no launcher do watcher do piloto; nada muda em `.claude/model-routing.json`.
3. A PRI-336 fecha antes do AUTORIZO; esta issue não a corrige.
4. O #144 entra como está; se o merge mudar o trecho do argv, esta branch faz rebase.

## Comandos

- Testes (receita `prisma-tests`): `node harness/run-tests.js` com `REPO_PATH` e `PRISMA_ROOT` absolutos.
- Foco: `node --test scripts/lib/plan-implement-chain.test.js scripts/lib/plan-implement-chain-watcher.test.js scripts/probes/effort-benchmark.test.js`.
- Fronteiras (Node 22+): `npm --prefix scripts run arch:check`.
- Demonstração: `node --test scripts/lib/plan-implement-chain-watcher.test.js` (despacho real com `claude` falso).
- Benchmark: `node scripts/probes/effort-benchmark.js --manifest <pares.json> --out ~/Workspace/prisma-evidence/<data>-pri-354-benchmark/`.

## Estrutura

- `scripts/lib/plan-implement-chain.js` (novo, puro): elegibilidade, comandos, nós que rodaram, fechamento do Attempt do implement.
- `scripts/readmine-watcher.js`: só o trecho do despacho do plan e do `releaseLease`.
- `scripts/lib/node-events.js`, `scripts/lib/node-lease.js`: saída com os nós que rodaram.
- `scripts/probes/effort-benchmark.js`: MINOR 3–6. Testes ao lado de cada arquivo.
- Evidência do piloto em `~/Workspace/prisma-evidence/`, nunca em `memory/` do consumidor.

## Estilo

CommonJS, `'use strict'`, 4 espaços e comentários em português que citam a issue
(`// PRI-354: …`). Funções puras na lib, efeito só no watcher. Motivos em CAIXA_ALTA
(`CHAIN_STOPPED_AFTER_PLAN`). Nunca lança no release: loga e segue.

## Testes

`node:test` + `assert`. Lib com teste unitário por condição de elegibilidade e por desfecho
de saída. Watcher com o harness do `claude` falso (o mesmo do `phase-effort-watcher.test.js`).
Golden do argv da PRI-315 e da PRI-353 continuam verdes. Novos testes entram na lista do
`npm test` do pacote.

## Boundaries

- **Sempre:** flag nova desligada; PR em draft com `Refs PRI-354`, rótulo `processo:alto`;
  evidência na seção Evidência do PR; UNKNOWN onde faltar medição.
- **Perguntar antes:** ligar qualquer flag no piloto, bump do checkout vivo, tocar no
  `app-back`, mudar a tabela de esforço, substituir run além da tolerância de D3.
- **Nunca:** encadear sob roteamento ON; contar o Attempt do implement como PASS sem ele ter
  rodado; dado do consumidor ou transcript na evidência; merge.

## Fora de escopo

Escalada dinâmica de esforço. Ligar a tabela em outro consumidor. Encadeamento sob roteamento
ON, que exige resolver o modelo por segmento e fica para issue própria. Medir custo em dinheiro.

## Riscos

- Custo de um segmento interrompido depois do plan cai no nó `implement` (`also_covers: plan`),
  como no `fetch_ticket+plan`. Por isso o benchmark marca como parcial (não comparável) toda fase rodada dentro de um segmento.
- No segmento, o watcher não grava `planScore` no state. O placar fica no log do agente, e a
  saída confere o plano de novo antes de aceitar o implement (revoga se reprovar).
- **Achado na implementação:** task nova roda o plan dentro do segmento `fetch_ticket+plan`, então
  o `[plan, implement]` só dispara quando o plan sai avulso (re-plan, plan depois do portão de
  spec, depois de SPEC_CHANGE). Estender para `[fetch_ticket, plan, implement]` muda o escopo:
  fica para decisão do Richard.
- Dois pilotos no mesmo consumidor confundem a leitura. Mitigação em D2.
- n=10 é indicador, não prova (mesma ressalva da PRI-341 Q3).

## Decisões (aprovadas pelo Richard em 15/11/2026, como recomendadas)

- **D1. Encadeamento fora do piloto.** Recomendo **não** ligar `WATCHER_PLAN_IMPLEMENT_CHAIN` no
  piloto: com o roteamento ON no Espectro, o segmento não é elegível. Ele fica pronto,
  demonstrado no teste do watcher com o `claude` falso (AC4). O gatilho para ligar é um consumidor com roteamento OFF,
  ou a issue de roteamento por segmento.
- **D2. Ordem dos pilotos.** Recomendo começar só depois das 3 runs de baseline da PRI-341, com
  a mesma policy de roteamento nos dois braços. Cada run grava `routing_snapshot` e
  `phase_effort`. O par difere só em `WATCHER_PHASE_EFFORT`.
- **D3. Pares e tolerância.** Recomendo par = dois tickets de porte parecido no Espectro, um por
  braço, alternando qual braço vai primeiro. Rodar o mesmo ticket duas vezes exige reset de
  worktree no consumidor. Run que falha por causa externa (indisponibilidade, `session_limit`,
  rede) é substituída, até 3 substituições; passou disso, para e pede decisão. Falha do agente
  conta como falha do braço.
- **D4. Readback.** Depois de ligar: um despacho do plan com o log mostrando `--effort high`, e
  um Attempt com `phase_effort.effort_applied: true`. Reverter = tirar a variável do launcher.
