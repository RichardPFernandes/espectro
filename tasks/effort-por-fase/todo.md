# Tarefas: PRI-353, esforço fixo por fase

> Fonte: [SPEC.md](SPEC.md) v0.3 e [plan.md](plan.md) (proposta). Fatias verticais: cada tarefa
> entrega um caminho completo e demonstrável, com a flag desligada por padrão. Cada tarefa segue
> TDD (o teste nasce falhando). Comando focado: `node --test scripts/lib/<arquivo>.test.js`.
> Registre todo teste novo na lista do `npm test` do pacote. Separado de `tasks/todo.md`
> (PRI-233), que continua com itens abertos.

## Ordem

`T1 → T2 → T6`, `T2 → T4`, `T3` solta, `T5` depois de `T2` e `T3`, `T7` por último.

## T1. Provar o mecanismo de esforço (U1) · gate

- [ ] «Sim» do Richard para o probe (chamadas reais, config pessoal, scratch, n=3 por nível).
- [x] Teste com fake: controle negativo (`--effort` inválido recusado) e agregação.
- [x] Rodada 1 (14/11/2026, n=3, low/medium/high, prompt curto): ACCEPTED_EFFECT_UNKNOWN. Controle `--effort bogus` saiu com exit 0; saída ~260 tokens em todos os níveis. Evidência: `~/Workspace/prisma-evidence/2026-11-14-pri-353-effort-probe/`.
- [x] Probe v2 (teste primeiro): prompt de raciocínio longo, contagem de blocos `thinking`, `--levels` (padrão low,max), controle inválido vira nota e não anula o efeito.
- [x] Rodada 2 (14/11/2026, «sim» do Richard, CLI 2.1.325, n=3, low/max): EFFECT_OBSERVED. Saída low 992/1258/1116 (mediana 1116) contra max 4018/3511/3651 (mediana 3651), sem sobreposição; blocos thinking 1 em todos (sem diferença). Controle `bogus` exit 0 (a CLI não valida valor inválido). Indício, não prova do mecanismo. Evidência: `~/Workspace/prisma-evidence/2026-11-14-pri-353-effort-probe-r2/`.

**AC:** AC1. **Arquivos:** `scripts/probes/effort-flag-probe.js`, `scripts/probes/effort-flag-probe.test.js`.
**Verifica:** saída agregada com versão da CLI (2.1.325), sem transcript copiado.
Resultado "aceita, efeito UNKNOWN" = **parar e pedir decisão** antes de T2 em diante que dependa de efeito.

### Checkpoint C1
- [x] AC1 fechado como EFFECT_OBSERVED, com evidência no PR (rodadas 1 e 2).
- [x] Richard aceitou o C1 em 14/11/2026 («aceito»). T2 a T6 liberadas. Antes disso a T2 rodou sem decisão explícita (reversível, flag desligada).

## T2. Esforço por fase, do JSON ao argv, atrás de flag

- [x] Teste: tabela válida; nível fora de `CLI_EFFORTS` recusado; nó sem entrada; run roteada com
      esforço aplicado não duplica `--effort`.
- [x] `scripts/lib/phase-effort.js` + `.claude/phase-effort.json` (tabela D1 e `reopen_criteria`).
- [x] Teste golden: flag desligada deixa o argv idêntico ao atual em todos os nós.
- [x] Ligar em `dispatchClaudeSegment` com `WATCHER_PHASE_EFFORT`; decisão grava `effort_applied: true` e o valor.
- [x] Demonstração: o teste do watcher despacha o plan com o `claude` falso e mostra `--effort high` no fim do argv com a flag ligada, e nenhum `--effort` com ela desligada.
- Registro: o Attempt ganha `phase_effort {level, effort_applied: true}` (campo opcional novo no schema). `requested.effort` continua UNAVAILABLE sem roteamento, porque a coerência do PRI-334 exige.

**AC:** AC2, AC3, AC7. **Arquivos:** `scripts/lib/phase-effort.js`, `scripts/lib/phase-effort.test.js`,
`.claude/phase-effort.json`, `scripts/readmine-watcher.js`.
**Verifica:** golden verde; `architecture-boundaries.test.js` verde.

## T3. Registro `effort_miss`, da gravação à leitura

- [x] Confirmar se `state.schema.json` aceita campo novo; run antiga sem o campo segue válida.
- [x] Teste: schema aceita o registro; `state-writer` grava com CAS; `would_high_catch` nasce `unknown`.
- [x] `scripts/lib/effort-miss.js` (puro) + `scripts/effort-miss.js` (gravação e CLI) + `scripts/effort-miss-read.js` (leitor do dashboard) + campo `effort_misses` no schema.
- [x] Endpoint read-only no dashboard; sem registro devolve UNKNOWN, nunca zero.

**AC:** AC6. **Arquivos:** `.graph/schemas/state.schema.json`, `scripts/state-writer.js`,
`scripts/lib/effort-miss.js`, `scripts/lib/effort-miss.test.js`, `dashboard/server.js`,
`dashboard/effort-miss-api.test.js`.
**Verifica:** `validate-state.js` em run arquivada; teste da API.

### Checkpoint C2
- [x] Suítes `scripts/` e `dashboard/` por `harness/run-tests.js` (14/11/2026, Node 20.20.2, HEAD 2ad0a15): `dashboard` 554/554; `scripts` 2035/2046, com 5 falhas idênticas às da base a2e956b (3 subtestes de `architecture-boundaries` e 2 «C0 árvore adversarial»; causa UNKNOWN, não investigada). Uma falha flaky de `plan-scorer.test.js` na 1ª rodada não voltou.
- [x] Com a flag desligada, nada muda no consumidor (golden verde; `architecture-boundaries` com os 3 subtestes pré-existentes vermelhos).
- [x] Richard aceitou o C2 em 14/11/2026 («aceito»), com a ressalva das 5 falhas pré-existentes na Evidência do PR e issue à parte para elas.

## T4. Handoff das fases em esforço alto

- [x] Teste: lint avisa `plan.md` sem plano, decisões, riscos ou arquivos afetados; flag desligada não altera o `extraNote`.
- [x] `scripts/lib/handoff-lint.js` (só aviso, D7; CLI sempre sai 0).
- [x] Com a flag ligada, o despacho acrescenta ao prompt do plan a instrução de gravar `## Decisões` no `plan.md` e rodar o lint. Só nó em esforço alto na tabela que escreve o `plan.md` (plan, implement); review usa `review_results`.
- Demonstração: `scripts/lib/phase-effort-watcher.test.js` despacha o plan com o `claude` falso: flag desligada, prompt sem a instrução; ligada, com ela; tabela inválida, sem ela e sem derrubar o despacho.
- Verificação (14/11/2026, Node 20.20.2): `scripts` 2054/2063; as 3 falhas são os subtestes de `architecture-boundaries` (dependency-cruiser exige Node ^22||^24||>=26), as mesmas da base. `handoff-lint.test.js` 14/14.

**AC:** AC4. **Arquivos:** `scripts/lib/handoff-lint.js`, `scripts/lib/handoff-lint.test.js`, `scripts/readmine-watcher.js`.
**Depende de:** T2 (mesmo trecho do argv; commit separado).

## T5. Benchmark visual do piloto

- [x] Teste com fixtures sintéticas rotuladas (`synthetic-*`); sem runs a página sai só com UNKNOWN (e N/A em fase fora de esforço médio).
- [x] `scripts/probes/effort-benchmark.js`: JSON + HTML com tempo, tokens (proxy de uso de limite), falhas e `effort_miss` por fase. Par com rótulo contradito por `phase_effort` é excluído e listado; sem Attempt registrado, o par entra sinalizado.
- [x] Reaproveita `run-comparator` (leitura, tokens por nó, status), `dashboard/cost-projection` (duração por nó) e `effort-miss` (projeção); sem lógica paralela de custo.
- [x] Página vazia gerada (14/11/2026): `~/Workspace/prisma-evidence/2026-11-14-pri-353-effort-benchmark-vazio/` (anexar ao PR).
- Verificação (14/11/2026, Node 20.20.2, base 9de609f): `scripts` 2079 testes, 2068 passam; as 5 falhas são as mesmas pré-existentes do C2 (3 de `architecture-boundaries`, 2 de «C0 árvore adversarial»). `effort-benchmark.test.js` 17/17.

**AC:** AC8. **Arquivos:** `scripts/probes/effort-benchmark.js`, `scripts/probes/effort-benchmark.test.js`.
**Depende de:** T2 (campo `effort_applied`), T3 (dados de `effort_miss`).

### Checkpoint C3
- [ ] Página do benchmark revisada pelo Richard (vazia, só UNKNOWN).
- [x] Revisão independente (G3, 1 revisor, 14/11/2026) do diff T1–T5: **FAIL**. MAJOR 2 (`effort_miss` sem denominador) corrigido na T5. **BLOCKER 1 (decisão do Richard em 15/11/2026: separar o módulo; aplicado, ver abaixo):** com Node 22, `arch:check` acusa 2 violações novas da T3 (`dashboard/server.js` → `scripts/lib/effort-miss.js`, regra `no-dashboard-scripts-internals`; `effort-miss.js` → `state-writer.js`, regra `no-lib-upward`), escondidas pelas falhas do Node 20. MINOR 3–6 (tabela latest, tokens/duração parciais, Δ não pareado, `--out` sem realpath) seguem para a PRI-354, salvo decisão em contrário. Segunda rodada só com decisão do Richard.
- [x] BLOCKER 1 aplicado (15/11/2026): `scripts/lib/effort-miss.js` ficou puro (validação, leitura, projeção); gravação e CLI `record` em `scripts/effort-miss.js`; o dashboard lê por processo via `scripts/effort-miss-read.js` (padrão do `routing-read.js`; falha do leitor = 502 UNKNOWN). `arch:check` em Node 22.23.2: sem violação nova (77 conhecidas ignoradas). Suítes (Node 20.20.2): `dashboard` 556/556; `scripts` 2086, 2075 passam, 5 falhas idênticas às da base.
- [x] Richard aceitou o C3 em 15/11/2026 («aceito»): página vazia + correção do BLOCKER 1. T6 liberada, com a decisão sobre o enforcement do plan ainda pendente.

## T6. Plan + implement na mesma sessão

- [x] Teste: argv do segmento `[plan, implement]` sem `--disallowedTools` nem `--settings` de deny; nós avulsos inalterados (golden da PRI-315 verde).
- [x] (parcial) `subagentBlockArgs` e a flag `WATCHER_PLAN_IMPLEMENT_CHAIN` prontos e ligados ao argv; **falta o despachante montar o segmento `[plan, implement]`** (ver decisão pendente abaixo). Suíte `scripts` 15/11/2026: 2091 testes, 2086 passam, as mesmas 5 falhas da base.
- [ ] Lease, admissão DOM06 e eventos registram os dois nós.
- [x] Richard aprovou em 15/11/2026: enforcement do plan no segmento encadeado fica só como texto (argv sem bloqueio).
- [x] Richard aprovou em 15/11/2026 a recomendação: T6 fecha parcial (flag + argv provados); o despachante que monta `[plan, implement]`, com plan-scorer entre os comandos, vai para a PRI-354 (Alto). Pendente: registrar isso na PRI-354.

**AC:** AC5. **Arquivos:** `scripts/lib/subagent-block.js`, `scripts/lib/subagent-block.test.js`, `scripts/readmine-watcher.js`.
**Depende de:** T1 (C1 aprovado) e T2.

## T7. Evidência e PR em draft

- [x] Seção Evidência no PR: versão da CLI, golden, suítes, página do benchmark vazia. AC5 entra como PARCIAL, sem arredondar.
- [x] `origin/main` (3 commits novos) integrado por merge `57ee94e`, para a evidência valer para a versão que entra. Suítes (15/11/2026, Node 20.20.2): `dashboard` 557/557; `scripts` 2195 testes, 2188 passam, 5 falham, 2 pulados. As 5 são as mesmas da base. Node 22.23.2: `arch:check` sem violação nova e `architecture-boundaries.test.js` 5/5.
- [x] Rótulo `processo:medio`; PR em draft; `Refs PRI-353`.
- [ ] Bloco de Estado da PRI-353 atualizado e decisão da T6 registrada na PRI-354.

**AC:** AC1 a AC8.

### Checkpoint C4
- [ ] `processo-check` verde; merge é do Richard.
