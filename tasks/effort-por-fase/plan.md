# Plano: Esforço fixo por fase (PRI-353)

> **Fonte:** [SPEC.md](SPEC.md) v0.3, D1–D8 aprovadas em 14/11/2026. **Issue:** PRI-353 (Médio).
> **Status:** PROPOSTA, aguardando aprovação. Nada codado. Base: `main` `a2e956b`.
> Este repo é a plataforma, não um consumidor: não há `memory/`, `state.json` nem `handoff.md`
> a gravar. O plano mora aqui; a evidência vai na seção Evidência do PR (draft, "Refs").

## Referência da Spec

- Spec: `tasks/effort-por-fase/SPEC.md` (v0.3)
- ACs: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8

## Diagnóstico

- A CLI 2.1.325 tem `--effort <low|medium|high|xhigh|max>`. Isso sugere que o U1 tem saída,
  mas **não é prova**: falta mostrar que o nível chega ao modelo.
- O esforço de hoje só passa pelo caminho roteado (`routedArgs`, `model-routing.js:359`) e só
  com `effort_mechanism = VERIFIED`. Esse caminho serve a policy do PRI-352 e **não muda nesta
  fatia**: mexer em `PRODUCTION_EFFORT_MECHANISM` alteraria runs roteadas (Alto).
- Logo, o esforço por fase vai num **módulo novo**, atrás de flag própria, usado só quando a
  run não é roteada com esforço aplicado. Roteada com `effort_applied: true` manda a policy.
- O despacho é um `claude -p` por nó (`readmine-watcher.js:5271`, `nodes: [node]`); o argv é
  montado em `dispatchClaudeSegment` (`:4321`).

## Decisões de arquitetura

- **`scripts/lib/phase-effort.js`**, módulo puro: `phaseEffortArgs({ node, flag, routedEffortApplied })`
  devolve `[]` ou `['--effort', nível]`. Tabela em `.claude/phase-effort.json` (D1), validada
  contra `CLI_EFFORTS`. Flag `WATCHER_PHASE_EFFORT` (`1|true|sim`), desligada por padrão,
  mesma convenção de `WATCHER_QA_DIAGNOSTICO`.
- **Flag desligada = argv idêntico**, provado por golden (AC2). Nada de leitura de arquivo
  nem de estado quando desligada.
- **Handoff sem tocar nos templates.** Em vez de editar `.claude/commands/plan.md` (que o
  plan-scorer e os consumidores já leem), o watcher acrescenta ao `extraNote` do despacho,
  só com a flag ligada, a instrução de gravar `## Decisões` no `plan.md`. Validador novo
  `scripts/lib/handoff-lint.js`, só aviso na v1 (D7).
- **Chaining atrás de segunda flag**, `WATCHER_PLAN_IMPLEMENT_CHAIN`, e só depois de AC1 e AC5
  (D3). No segmento encadeado o bloqueio `--disallowedTools Agent,Task` **não vale** (tiraria
  o Agent do implement). A regra "plan sem subagente" fica só no texto do comando e o teste de
  AC5 fixa isso. Perda de enforcement: ver Riscos.
- **`effort_miss`** em `state.json` (D4) como lista `effort_misses`, gravada por
  `state-writer.js`, nunca à mão. Leitura read-only pelo dashboard. Review/verify/humano
  registram; `would_high_catch` nasce `unknown`.
- **Benchmark offline** (AC8), no padrão de `scripts/probes/plan-cache-probe.js`: não toca
  watcher, estado nem consumidor. Gera JSON + HTML. Sem medição = UNKNOWN.

## Plano de execução

0. **Portão:** a prova do passo 1 faz chamadas reais e gasta a assinatura. Peço o «sim» do
   Richard antes de rodar (como na D2 da PRI-315). Sem «sim», o passo 1 vira só o teste com
   fake e AC1 fica UNKNOWN.
1. Prova do mecanismo de esforço (U1).
   - Arquivo: `scripts/probes/effort-flag-probe.js`, `scripts/probes/effort-flag-probe.test.js`
   - Critérios: AC1
   - Verificação: controle negativo (`--effort` inválido recusado) + `n` execuções em cada
     nível numa tarefa fixa de scratch, registrando o que for observável (evento `init`,
     transcript, tokens de saída). Saída agregada com versão da CLI; nenhum transcript copiado.
     Se só der para provar que a flag é aceita, e não que muda o comportamento, o resultado
     é "aceita, efeito UNKNOWN" e eu paro e peço decisão antes de seguir.
2. Módulo e tabela do esforço por fase.
   - Arquivo: `scripts/lib/phase-effort.js`, `scripts/lib/phase-effort.test.js`, `.claude/phase-effort.json`
   - Critérios: AC3, AC7
   - Verificação: testes unitários (tabela válida, nível fora de `CLI_EFFORTS` recusado, nó
     sem entrada, roteada com esforço aplicado não duplica). Critério de reabertura da
     escalada fica em campo `reopen_criteria` do mesmo JSON e na SPEC.
3. Ligar o módulo ao argv do despacho, atrás da flag.
   - Arquivo: `scripts/readmine-watcher.js`, `scripts/lib/phase-effort.test.js`
   - Critérios: AC2, AC3
   - Verificação: golden do argv com flag desligada idêntico ao atual, para todos os nós;
     com flag ligada, cada nó leva o `--effort` da tabela; decisão grava `effort_applied: true`
     e o valor. Rodar `architecture-boundaries.test.js`.
4. Handoff das fases em esforço alto.
   - Arquivo: `scripts/lib/handoff-lint.js`, `scripts/lib/handoff-lint.test.js`, `scripts/readmine-watcher.js`
   - Critérios: AC4
   - Verificação: lint reprova (como aviso) `plan.md` sem plano, decisões, riscos ou arquivos
     afetados; flag desligada não acrescenta nada ao `extraNote`.
5. Registro `effort_miss`.
   - Arquivo: `.graph/schemas/state.schema.json`, `scripts/state-writer.js`, `scripts/lib/effort-miss.js`, `scripts/lib/effort-miss.test.js`, `dashboard/server.js`, `dashboard/effort-miss-api.test.js`
   - Critérios: AC6
   - Verificação: schema aceita o registro; `state-writer` grava com CAS; run antiga sem o
     campo continua válida (`validate-state.js`); endpoint read-only devolve UNKNOWN onde
     não há registro. Confirmar antes se o schema permite campo novo (`additionalProperties`).
6. Segmento plan+implement na mesma sessão, atrás de `WATCHER_PLAN_IMPLEMENT_CHAIN`.
   - Arquivo: `scripts/lib/subagent-block.js`, `scripts/lib/subagent-block.test.js`, `scripts/readmine-watcher.js`
   - Critérios: AC5
   - Verificação: teste do argv do segmento `[plan, implement]` sem `--disallowedTools` nem
     `--settings` de deny; nós avulsos inalterados (golden da PRI-315 segue verde); lease,
     admissão DOM06 e eventos registram os dois nós. Só entra depois de 1 e 3 verdes.
7. Benchmark visual do piloto.
   - Arquivo: `scripts/probes/effort-benchmark.js`, `scripts/probes/effort-benchmark.test.js`
   - Critérios: AC8
   - Verificação: fixtures sintéticas rotuladas geram a página; sem runs, a página sai só com
     UNKNOWN. Reaproveitar `scripts/compare-runs.js` e `dashboard/cost-projection.js` onde
     servirem, sem lógica paralela de custo.
8. Evidência e PR em draft.
   - Arquivo: `.github/pull_request_template.md`
   - Critérios: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8
   - Verificação: seção Evidência com a versão da CLI, golden, suíte `scripts/` e
     `dashboard/` via `harness/run-tests.js`, e a página do benchmark vazia. `Refs PRI-353`.

## Fatias, dependências e checkpoints

Os passos acima são a lista de arquivos. A execução vai em **fatias verticais**, em
[todo.md](todo.md): T1 prova U1; T2 leva o esforço do JSON ao argv; T3 faz o `effort_miss` da
gravação à leitura; T4 o handoff; T5 o benchmark; T6 o encadeamento; T7 a evidência. Grafo:
`T1 → T2 → T6`, `T2 → T4`, `T3` solta, `T5` depende de T2 e T3. Checkpoints: C1 após T1 (decisão
sobre o resultado do U1), C2 após T2 e T3 (suítes verdes, flag desligada sem efeito), C3 após T4
e T5 (G3 e página do benchmark), C4 no PR.

## Cobertura dos ACs

- AC1 → passos 0, 1 — probe com controle negativo, só com «sim».
- AC2 → passo 3 — golden do argv com flag desligada.
- AC3 → passos 2, 3 — tabela validada e `effort_applied` gravado.
- AC4 → passo 4 — instrução condicional no despacho e lint só-aviso.
- AC5 → passo 6 — argv do segmento encadeado sem bloqueio vazando.
- AC6 → passo 5 — campo no schema, escrita pelo writer, leitura read-only.
- AC7 → passo 2 — `reopen_criteria` no JSON da tabela e na SPEC.
- AC8 → passo 7 — harness offline e página com UNKNOWN.

## Fora de escopo

Escalada dinâmica; análise de negócio; ligar qualquer flag em consumidor (PRI-354, Alto);
mudar `PRODUCTION_EFFORT_MECHANISM` ou a policy de roteamento do PRI-352; editar
`.claude/commands/*`; rodar o piloto.

## Riscos técnicos

- Perfil: G1 — muda argv do despacho atrás de flag desligada, sem tocar estado autoritativo
  nem autorização; capabilities afetadas: despacho do watcher, schema de `state.json`.
- **U1 pode ficar em "aceita, efeito UNKNOWN".** Então a tabela não prova nada e eu paro no
  passo 1 com a recomendação, sem seguir para 3, 6 e 7.
- **Segmento encadeado perde o bloqueio de subagente do plan.** A regra vira texto. Se o
  Richard quiser enforcement duro, o caminho é um `--settings` de deny só para o plan, mas
  isso conflita com a prova SP-2 em run roteada (dois `--settings` não provados). Pergunta
  aberta, não bloqueia os passos 1 a 5.
- Mudar `state.schema.json` pode reprovar runs arquivadas; o passo 5 testa run antiga.
- `scripts/readmine-watcher.js` é grande e compartilhado: os passos 3, 4 e 6 tocam o mesmo
  trecho do argv. Fazer em commits separados e rodar o golden a cada um.
- Uso da assinatura: o passo 1 e o piloto consomem limite. O passo 1 é pequeno (scratch, `n`
  baixo); o piloto é da PRI-354.

## Decisão que preciso de você

**«Sim» para o probe do passo 1** (chamadas reais, config pessoal, diretório scratch, `n=3`
por nível em low, medium, high). Recomendo **sim**: sem ele não há como fechar o AC1. Sem
resposta até a janela de segunda ou quinta, sigo com os passos 2 a 5 e deixo o AC1 como UNKNOWN.
