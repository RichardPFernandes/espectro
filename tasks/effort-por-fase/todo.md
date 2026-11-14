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
- [ ] Teste com fake: controle negativo (`--effort` inválido recusado) e agregação.
- [ ] Rodar o probe em low, medium, high e registrar o que for observável.

**AC:** AC1. **Arquivos:** `scripts/probes/effort-flag-probe.js`, `scripts/probes/effort-flag-probe.test.js`.
**Verifica:** saída agregada com versão da CLI (2.1.325), sem transcript copiado.
Resultado "aceita, efeito UNKNOWN" = **parar e pedir decisão** antes de T2 em diante que dependa de efeito.

### Checkpoint C1
- [ ] AC1 fechado como VERIFIED, UNAVAILABLE ou "aceita, efeito UNKNOWN", com evidência no PR.
- [ ] Richard decide se T2 a T6 seguem. Sem resposta até a janela de segunda ou quinta, T2 a T5 seguem.

## T2. Esforço por fase, do JSON ao argv, atrás de flag

- [ ] Teste: tabela válida; nível fora de `CLI_EFFORTS` recusado; nó sem entrada; run roteada com
      esforço aplicado não duplica `--effort`.
- [ ] `scripts/lib/phase-effort.js` + `.claude/phase-effort.json` (tabela D1 e `reopen_criteria`).
- [ ] Teste golden: flag desligada deixa o argv idêntico ao atual em todos os nós.
- [ ] Ligar em `dispatchClaudeSegment` com `WATCHER_PHASE_EFFORT`; decisão grava `effort_applied: true` e o valor.
- [ ] Demonstração: despacho simulado (`SIMULATE`) mostra o `--effort` de cada nó com a flag ligada.

**AC:** AC2, AC3, AC7. **Arquivos:** `scripts/lib/phase-effort.js`, `scripts/lib/phase-effort.test.js`,
`.claude/phase-effort.json`, `scripts/readmine-watcher.js`.
**Verifica:** golden verde; `architecture-boundaries.test.js` verde.

## T3. Registro `effort_miss`, da gravação à leitura

- [ ] Confirmar se `state.schema.json` aceita campo novo; run antiga sem o campo segue válida.
- [ ] Teste: schema aceita o registro; `state-writer` grava com CAS; `would_high_catch` nasce `unknown`.
- [ ] `scripts/lib/effort-miss.js` + campo `effort_misses` no schema + escrita pelo `state-writer`.
- [ ] Endpoint read-only no dashboard; sem registro devolve UNKNOWN, nunca zero.

**AC:** AC6. **Arquivos:** `.graph/schemas/state.schema.json`, `scripts/state-writer.js`,
`scripts/lib/effort-miss.js`, `scripts/lib/effort-miss.test.js`, `dashboard/server.js`,
`dashboard/effort-miss-api.test.js`.
**Verifica:** `validate-state.js` em run arquivada; teste da API.

### Checkpoint C2
- [ ] Suítes `scripts/` e `dashboard/` verdes por `harness/run-tests.js`.
- [ ] Com a flag desligada, nada muda no consumidor (golden + diff do argv).

## T4. Handoff das fases em esforço alto

- [ ] Teste: lint avisa `plan.md` sem plano, decisões, riscos ou arquivos afetados; flag desligada não altera o `extraNote`.
- [ ] `scripts/lib/handoff-lint.js` (só aviso, D7).
- [ ] Com a flag ligada, o despacho acrescenta ao `extraNote` a instrução de gravar `## Decisões`.

**AC:** AC4. **Arquivos:** `scripts/lib/handoff-lint.js`, `scripts/lib/handoff-lint.test.js`, `scripts/readmine-watcher.js`.
**Depende de:** T2 (mesmo trecho do argv; commit separado).

## T5. Benchmark visual do piloto

- [ ] Teste com fixtures sintéticas rotuladas; sem runs a página sai só com UNKNOWN.
- [ ] `scripts/probes/effort-benchmark.js`: JSON + HTML com tempo, uso de limite, falhas e `effort_miss` por fase.
- [ ] Reaproveitar `scripts/compare-runs.js` e `dashboard/cost-projection.js`; sem lógica paralela de custo.
- [ ] Gerar a página vazia e anexar ao PR.

**AC:** AC8. **Arquivos:** `scripts/probes/effort-benchmark.js`, `scripts/probes/effort-benchmark.test.js`.
**Depende de:** T2 (campo `effort_applied`), T3 (dados de `effort_miss`).

### Checkpoint C3
- [ ] Página do benchmark revisada pelo Richard (vazia, só UNKNOWN).
- [ ] Revisão independente (G3) do que existe até aqui, antes de T6.

## T6. Plan + implement na mesma sessão

- [ ] Teste: argv do segmento `[plan, implement]` sem `--disallowedTools` nem `--settings` de deny; nós avulsos inalterados (golden da PRI-315 verde).
- [ ] Segmento encadeado atrás de `WATCHER_PLAN_IMPLEMENT_CHAIN`.
- [ ] Lease, admissão DOM06 e eventos registram os dois nós.
- [ ] Decisão do Richard sobre o enforcement do plan (hoje só texto).

**AC:** AC5. **Arquivos:** `scripts/lib/subagent-block.js`, `scripts/lib/subagent-block.test.js`, `scripts/readmine-watcher.js`.
**Depende de:** T1 (C1 aprovado) e T2.

## T7. Evidência e PR em draft

- [ ] Seção Evidência: versão da CLI, golden, suítes, página do benchmark vazia.
- [ ] Rótulo `processo:medio`; PR em draft; `Refs PRI-353`; atualizar o bloco de Estado da issue.

**AC:** AC1 a AC8.

### Checkpoint C4
- [ ] `processo-check` verde; merge é do Richard.
