# Tarefas: PRI-233 (PRI-205 S4)

> Fonte: [SPEC.md](../SPEC.md) (aprovado em 2026-11-06) e [plan.md](plan.md)
> (proposta). Cada tarefa segue TDD: o teste nasce falhando. Comando focado:
> `node --test scripts/lib/<arquivo>.test.js`. Registre todo teste novo na lista do
> `npm test` do pacote.

## Fase 0: rede de segurança

## Tarefa 1: golden de argv/env do AS-IS

**Descrição:** antes de qualquer mudança, capturar o argv e o env que o watcher
passa ao `claude` (stub no PATH, no padrão do `dom06-dispatch-env.test.js`) para
cada forma de despacho: o segmento `fetch_ticket + plan`, cada nó do grafo e as
causas `dispatch`, `retry`, `timeout` e `resume`. Comparar com e sem
`routing` (ausente e `mode: OFF`). Campos voláteis, como `--session-id` e
caminhos de tmp, são normalizados explicitamente e listados no teste.

**Critérios de aceite:**
- [x] O teste passa na `origin/main` atual (829254d), antes da T2. O commit do golden ainda está pendente.
- [x] `mode` ausente e `mode: OFF` produzem argv/env iguais ao golden em 25 cenários, todos `dispatched`.
- [x] A lista de campos normalizados está no teste, com o motivo de cada um.

**Verificação (2026-11-06):**
- [x] `node --test scripts/lib/routing-off-golden.test.js`, via receita oficial: passa. A mutação `--model` no argv é detectada.
- [x] `cd scripts && npm test` no Node 22.23.2 (como o CI): 1119 passam, 0 falham, 6 pulados. No Node 20.20.2, 3 falhas pré-existentes no `architecture-boundaries` (o dependency-cruiser exige Node ≥ 22), sem relação com a T1.
- [x] `dashboard npm test` no Node 22: 298 passam, 0 falham. `check:js` e `lint:src` limpos.

**Dependências:** nenhuma.
**Arquivos:** `scripts/lib/routing-off-golden.test.js` (novo), fixture do golden, `scripts/package.json`.
**Tamanho:** M. **ACs do SPEC:** AC-01.

## Fase 1: fundação pura

## Tarefa 2: validação de `routing` e policy para `mode = ON`

**Descrição:** uma função única valida o bloco `routing` do consumidor (`mode`
ausente → OFF; `OFF`/`ON`; malformado → inválido) e a policy referenciada
(presença, schema, sha256 igual ao aprovado, `default_route` explícito, ids e
esforços não `UNAVAILABLE` quando `mode = ON`, mapeamento de esforço total). Ela
vira regra nova do `config-validator.js` e é exportada para a admissão. O loader
da S3 passa a aceitar policy de produção sem mudar o caminho sombra.

**Critérios de aceite:**
- [x] Um teste por desfecho: ausente, OFF, ON válido, ON com policy ausente, schema inválido, sha divergente, `mode` malformado, `UNAVAILABLE` com ON e leitura transitória × hash divergente (diretriz R-6 n.º 6). São 28 casos em `routing-config.test.js`, incluindo caminho absoluto, `..` e link simbólico para fora da raiz.
- [x] Os testes da S3 (`would-route.test.js`) passam sem mudança, e o caminho sombra do loader continua igual (teste dedicado).
- [x] A regra `routing-config` no `validateAll` dá `error` só para ON inválido; ausente e OFF passam sem ler policy. O contrato foi para 1.2.0 (regra nova não reprova config antes válida).

**Verificação (2026-11-06):**
- [x] `routing-config.test.js` 28/28, `config-validator.test.js` 23/23.
- [x] No Node 22: scripts 1148 pass / 0 fail / 6 skip; dashboard 298 pass / 0 fail; `check:js` e `lint:src` limpos; golden da T1 inalterado.
- [x] Mudança de teste existente: o teste do CLI agora espera "7 regras passaram" em vez de 6, por causa da regra nova. Não é enfraquecimento.

**Decisões de implementação:** a validação roteada fica no `model-routing-policy.js` (`validateRoutedPolicy`, `readRoutingConfig`), sem módulo novo. A policy roteada exige `mode: ROUTED`, `id`, ids de modelo reais, `default_route` dentro do T3 e um `effort_map` total para low/medium/high/xhigh/max. Os códigos de E/S transitórios são EIO, EAGAIN, EBUSY, EMFILE, ENFILE, ETIMEDOUT e EINTR.

**Dependências:** T1.
**Arquivos:** `scripts/lib/config-validator.js` (+test), `scripts/lib/model-routing-policy.js` (+test).
**Tamanho:** M. **ACs do SPEC:** AC-04 (parte de validação), AC-13.

## Tarefa 3: resolver §4.7 e RoutingDecision

**Descrição:** módulo puro `model-routing.js`. Recebe o snapshot, os sinais, as
overrides, o estado do provider e as capacidades injetadas (mecanismo de esforço
e prova do plugin), e devolve `{ ok, decision }` ou
`{ ok: false, cause: NOT_STARTED, reason }`. Os passos 1 a 5 do §4.7 seguem esta
ordem: Implement = classe máxima dos grupos (A1); demais nós = `default_route`
(A2); sinais UNKNOWN → C4 `CONSERVATIVE_DEFAULT`; R1–R8 sempre ativos e
`classifier.provider` só para o núcleo 2 (A3); `jev` sem Authority Ref → `off`
com motivo (A4); candidatos na ordem da policy, subindo de tier, nunca
descendo. Também monta o argv roteado (`--model`, esforço, `--settings`) só a
partir de uma decisão `ok`.

**Critérios de aceite:**
- [x] Cada passo tem teste de sucesso e de falha com a causa e o motivo exatos (AC-05 a AC-08 em unidade).
- [x] Determinismo: 100 execuções com a mesma entrada dão a mesma saída serializada (AC-12).
- [x] O caminho feliz com mecanismo injetado produz a RoutingDecision com todos os campos do AC-02 e `subagent: UNENFORCED`.
- [x] R1–R8 não estão duplicados: o módulo reusa `classifySubtask` da S3 (que já aplica o "Plan só sobe" e o C4 conservador), e um teste confere a identidade.

**Verificação (2026-11-06):**
- [x] `model-routing.test.js` 39/39.
- [x] Node 22: scripts 1187 pass / 0 fail / 6 skip (rodada isolada); dashboard exit 0; `check:js`, `lint:src` e `arch:check` limpos ("no dependency violations"; baseline inalterado).
- [x] Observação: numa rodada com scripts e dashboard em paralelo, 3 testes de tempo do `cost-tracking` do watcher falharam por timeout. Sozinho, o arquivo passou 29/29, e a suíte inteira isolada passou. A T3 não toca esses arquivos.

**Decisões de implementação:**
- O snapshot carrega a policy inteira e um `eligible_set` (provider + modelos dos tiers) com o seu próprio ref sha256. O sha256 do snapshot é canônico, com chaves ordenadas.
- Provider com estado diferente de `ACTIVE` (inclusive `UNKNOWN`) não é elegível. Na S4 o chamador informa `ACTIVE`, porque não existe dono do estado do provider (UNK-AR-005).
- A vigência da override é `recorded_at ≤ nodeBoundaryAt`; instante inválido fica em `overrides_pending`.
- Ordem das precondições: primeiro o mecanismo de esforço, depois a prova do plugin. Em produção, hoje, a causa reportada é sempre `EFFORT_MECHANISM_UNAVAILABLE`.
- A decisão recusada ainda guarda os candidatos e o par que seria usado.

**Dependências:** T2.
**Arquivos:** `scripts/lib/model-routing.js` (novo, +test), `scripts/lib/would-route.js` (export, se faltar), `ownership.yaml`, baseline do cruiser.
**Tamanho:** M. **ACs do SPEC:** AC-02, AC-03, AC-06, AC-07, AC-11, AC-12 (unidade).

## Tarefa 4: DOM06, `NOT_STARTED` e reserva de `escalation`

**Descrição:** o DOM06 passa a gravar Attempt com `result: NOT_STARTED` e um
motivo de roteamento (`CONFIG_UNVERIFIABLE`/`PROVIDER_NOT_ELIGIBLE` + detalhe),
sem spawn e sem PASS. A causa `escalation` é recusada com erro explícito em
`beginAttempt`, `retryAttempt` e `prepareDispatch` e não é mais convertida em
`dispatch`. `escalation_proposal` ganha um validador de forma, sem produtor.

**Critérios de aceite:**
- [x] Um Attempt `NOT_STARTED` fica gravado com `started: false`, motivo e detalhe, e `spawnIfAdmitted` não chama o spawn. Causa fora de `CONFIG_UNVERIFIABLE`/`PROVIDER_NOT_ELIGIBLE` vira `UNKNOWN`.
- [x] `cause: 'escalation'` nas três funções lança `ESCALATION_CAUSE_RESERVED`, sem gravar Attempt (AC-10). Outra causa desconhecida continua virando `dispatch`, como hoje.
- [x] Os testes atuais do DOM06 e o `dom06-dispatch-env.test.js` passam. A RoutingDecision só entra no Attempt quando é passada; o Attempt AS-IS segue sem o campo `routing`.

**Verificação (2026-11-06):**
- [x] `dom06-attempt.test.js` 16/16 (7 novos).

**Dependências:** T1 (pode andar em paralelo com T2/T3).
**Arquivos:** `scripts/lib/dom06-attempt.js` (+test).
**Tamanho:** S. **ACs do SPEC:** AC-10, base de AC-05 a AC-08.

### Checkpoint A
- [x] Node 22: scripts 1194 pass / 0 fail / 6 skip; dashboard 298 / 0.
- [x] `check:js`, `lint:src` e `arch:check` limpos (sem violação nova).
- [x] Golden da T1 inalterado.
- [ ] Revisão do Richard antes da fase 2.
- **Instabilidade observada (UNKNOWN se é pré-existente):** 3 testes de tempo do watcher em `cost-tracking.test.js` (298, 299 e 303; os dois últimos em cascata do 298) falharam em 2 de 6 rodadas completas da suíte scripts nesta sessão. Sozinho, o arquivo passou 4 de 4. A causa provável é o `waitFor` de 5 s sob carga, com os arquivos de teste rodando em paralelo; o golden da T1 acrescenta processos do watcher à rodada. Nenhuma tarefa da S4 toca `cost-tracking` até a T7. Não comparei com a base sem a T1.

## Fase 2: ligação no despacho

## Tarefa 5: snapshot `routing` na admissão e ligação à task

**Descrição:** no ramo de ticket novo, com `mode = ON` válido, montar o snapshot
canônico (`mode`, `policy_ref`, `default_route`, `eligible_set_ref`, sha256) e
gravá-lo no `admission.snapshot` do Attempt `fetch_ticket`. Quando a task
aparecer, ligar `routing_snapshot { attempt_id, sha256 }` via `state-writer`
(P-4). Os Attempts de nó leem só esse snapshot. Se o snapshot estiver ilegível
ou com sha divergente, a resposta é `CONFIG_UNVERIFIABLE`, sem reler a config.

**Critérios de aceite:**
- [x] Watcher com stub: depois da admissão ON, a task tem `routing_snapshot` com um sha igual ao do Attempt `fetch_ticket`. A ligação acontece no primeiro despacho de nó.
- [x] Mudar a config do consumidor depois da admissão não muda o snapshot da Run em andamento. Ligar ON depois não muda uma Run admitida OFF.
- [~] Snapshot corrompido ou apagado: `loadRunSnapshot` devolve `ok:false` (ilegível, ausente, adulterado, ligação divergente, `attempt_id` com caminho) em teste de unidade. O `NOT_STARTED` no watcher fica para a T7, que é quem chama o resolver.
- [x] (antecipado da T6) Admissão ON inválida recusa antes de worktree, marcador ou Attempt. O aviso humano fica para a T6.

**Verificação (2026-11-06):**
- [x] `routing-run.test.js` 13/13; `routing-admission-watcher.test.js` 3/3.
- [x] Node 22: scripts 1210 pass / 0 fail / 6 skip, com o golden da T1 inalterado; dashboard 298/0; `check:js`, `lint:src` e `arch:check` limpos.

**Decisões de implementação:** `routing-run.js` (leitura, sem escrita). Com `routing` passado, o `prepareDispatch` o acrescenta ao snapshot do fetch_ticket. `routing_snapshot` foi documentado no schema do state (opcional). O vínculo usa o fetch_ticket mais recente criado até o `started_at` da task.

**Dependências:** T3, T4.
**Arquivos:** `scripts/readmine-watcher.js`, `scripts/state-writer.js` e o schema do state (só o campo `routing_snapshot`), `scripts/lib/routing-admission-watcher.test.js` (novo).
**Tamanho:** M. **ACs do SPEC:** AC-04 (Run em andamento), AC-05.

## Tarefa 6: bloqueio de admissão e aviso único por projeto

**Descrição:** com `mode = ON` e validação da T2 com falha, o ramo de ticket novo
retorna **antes** de `writeSpecGate`/`prepareDispatch`: nenhuma Run e nenhum
Attempt são criados. Sai um aviso pelo canal existente (Redmine + `notify`,
padrão de marcador do `notifyPretaskBlocked`), uma vez por assinatura
`(projeto, causa, sha)`. O aviso traz a última policy válida só como sugestão e
a saída humana registrada (`mode: OFF`).

**Critérios de aceite:**
- [x] Watcher com stub e um consumidor ON inválido: o stub `claude` não é invocado, não aparece worktree nem `fetch_dispatch`, e há exatamente um PUT no Redmine em 3 ticks mais um segundo ticket do mesmo projeto (um aviso por projeto).
- [x] Um segundo consumidor OFF despacha normalmente. A igualdade do argv com o golden já é coberta pelo teste da T1.
- [x] Corrigir a policy libera no tick seguinte e remove o marcador.
- [x] Leitura transitória bloqueia sempre, mas só avisa no 3º bloqueio seguido (unidade, `blockedNotice`).
- [ ] Diretriz R-6 n.º 4 (última policy válida como sugestão): **não implementada**. O aviso sugere corrigir o `policy_ref` ou usar `mode: OFF`. Registrar a última policy válida exigiria um estado novo, fora do escopo.

**Verificação (2026-11-06):**
- [x] `routing-run.test.js` 17/17; `routing-admission-watcher.test.js` 4/4.
- [x] Node 22: scripts 1215 pass / 0 fail / 6 skip (2ª rodada), com o golden inalterado; dashboard 298/0; `check:js`, `lint:src` e `arch:check` limpos.
- **Instabilidade:** na 1ª rodada completa, falhou `churn-detector.test.js` › "CHURN_THRESHOLD=2 escala na segunda rodada" (sozinho: 14/14; 2ª rodada completa: verde). Junto com o `cost-tracking` (Checkpoint A), são dois arquivos de teste do watcher instáveis sob carga. Os testes novos da S4 sobem cerca de 60 processos do watcher por rodada, o que provavelmente aumenta a disputa. Tratar antes da PR.

**Dependências:** T2, T5.
**Arquivos:** `scripts/readmine-watcher.js`, `scripts/lib/routing-admission-watcher.test.js`.
**Tamanho:** M. **ACs do SPEC:** AC-04; diretrizes R-6 n.º 2, 3, 4 e 5.

## Tarefa 7: despacho por nó com resolução, recusas e RoutingDecision

**Descrição:** em cada despacho com snapshot ON, chamar o resolver da T3 antes do
`prepareDispatch`. Recusa → Attempt `NOT_STARTED` (T4), Run bloqueada pelo
caminho humano existente e um aviso por assinatura, sem novo Attempt a cada tick.
Sucesso (só alcançável com mecanismo injetado, AD-5) → argv roteado. Em todos os
casos, `cost-tracking` grava `requested`, `selection_source`, `routing_decision`
e `effort_router_plugin`. Com o snapshot OFF, o código atual segue intocado.

**Critérios de aceite:**
- [x] Watcher com stub, mode ON e produção (mecanismo `UNAVAILABLE`): a Run em andamento dá 1 Attempt `NOT_STARTED/CONFIG_UNVERIFIABLE` (`EFFORT_MECHANISM_UNAVAILABLE`) com a RoutingDecision, a Run fica `blocked` e há 1 aviso em 3 ticks, sem o stub rodar (AC-07). O ticket novo ON dá o mesmo resultado no `fetch_ticket`, no `default_route` (AC-03).
- [~] AC-08 (conta com `skills/` → LOADED): provado em unidade (`routedPluginProof`, 6 casos). No watcher a prova só roda com o esforço verificado, que não existe em produção (AD-5, sem porta dos fundos).
- [~] AC-06 (`PROVIDER_NOT_ELIGIBLE`): provado em unidade. No watcher o provider é `ACTIVE` fixo (UNK-AR-005).
- [x] AC-05 no watcher: snapshot adulterado + config corrente OFF → `NOT_STARTED/CONFIG_UNVERIFIABLE` (`snapshot_hash_mismatch`), sem despachar. Prova que a config não é relida.
- [x] O registro de custo usa `requested`, `selection_source` e `routing_decision` da decisão quando há despacho roteado. A recusa não gera registro de custo (não há spawn) e fica no Attempt DOM06 (`not_started` + `routing`).
- [x] Golden da T1 inalterado.

**Verificação (2026-11-06):**
- [x] `routing-admission-watcher.test.js` 7/7; `claude-account.test.js` 9/9; `cost-tracking.test.js` 30/30.
- [x] Node 22: scripts 1225 pass / 0 fail / 6 skip; dashboard 298/0; `check:js`, `lint:src` e `arch:check` limpos.
- **Testes da T5 e da T6 alterados de propósito:** com ON válido, o ticket novo agora para em `NOT_STARTED` (SP-1). O teste de ligação da T5 passou a semear uma Run admitida ON pelo DOM06 real, e o caso "policy corrigida" da T6 agora espera `routing_not_started`.
- **Ordem do TDD:** em `routedPluginProof` o teste e a implementação foram escritos juntos, não um antes do outro.

**Dependências:** T5, T6.
**Arquivos:** `scripts/readmine-watcher.js`, `scripts/lib/cost-tracking.js` (+test), `scripts/lib/claude-account.js` (+test), `scripts/lib/routing-admission-watcher.test.js`.
**Tamanho:** M (no limite: se passar de 5 arquivos, separar `cost-tracking` numa T7b).
**ACs do SPEC:** AC-02 (registro), AC-03, AC-06, AC-07, AC-08.

### Checkpoint B
- [x] Suítes completas e checks estáticos verdes; golden inalterado (2026-11-06, Node 22).
- [x] Revisão independente (agente `code-reviewer`, sem contexto da sessão), faixa `829254d..4311575`: **CHANGES_REQUESTED**, sem BLOCKER.

**O que foi feito com cada achado da revisão (2026-11-06):**

| Achado | O que foi feito |
| -- | -- |
| MAJOR-1: ligação por timestamp podia cair em OFF | **Corrigido.** Na admissão ON, o watcher grava o ponteiro `_dom06/routing-admission.json` com o id do Attempt; a admissão OFF o apaga. A ligação usa esse ponteiro e o marca como consumido. Ponteiro ilegível, já consumido ou ligação sumida do state levam a `CONFIG_UNVERIFIABLE`, nunca a OFF, e não há religação. Testes no watcher para (a) Attempt apagado, (b) `started_at` no passado, (d) religação e ponteiro de um ciclo ON anterior. O item (e), leitura no caminho OFF, ficou reduzido a um `existsSync` do ponteiro. |
| MAJOR-2: prova do plugin ignorava o projeto e o managed | **Corrigido.** A prova lê `settings.json` e `settings.local.json` do cwd do despacho e `.claude/skills/` do projeto. Managed presente dá UNKNOWN. 5 testes novos; os antigos passam a injetar o caminho do managed. |
| MINOR-1: roteamento depois de portões com efeito | **Corrigido.** O bloco foi para logo depois do retorno de `DRY_RUN`, antes de pré-build, churn e `human-input`; a recusa grava no próprio objeto, preservando a base do CAS. Teste: `human-input.md` não é consumido. |
| MINOR-2: ticket novo cria o worktree antes de recusar | ~~Aceito e registrado.~~ **Corrigido na 2ª revisão (MAJOR-2):** o pré-teste do ticket novo avalia a prova do plugin só por leitura, antes de qualquer git; na recusa não há branch nem worktree, e o aviso usa o marcador `RUNS_DIR/<id>-routing-not-started.json`. |
| MINOR-3: aviso calado por marcador antigo | **Corrigido.** A recusa limpa o marcador do nó ao entrar em `blocked`. |
| MINOR-4: `effort_router_plugin` contraditório | **Corrigido.** O registro de custo usa o valor da decisão. |
| MINOR-5: policy embutida sem validação estrutural | **Corrigido.** `snapshotIntegrity` roda `validateRoutedPolicy` e devolve `snapshot_policy_invalid`. |
| MINOR-6: aviso marcado como enviado mesmo com falha no Redmine; `refuseRoutedFetch` sem notificação local | **Aceito como está, igual ao AS-IS.** Notificação local e Dashboard ficam com a T9. |
| MINOR-7: Attempt duplicado em crash | **Corrigido.** A deduplicação é feita pelo último Attempt `fetch_ticket` antes de gravar outro. |
| MINOR-8: Authority Ref sempre null (item 11 / A4) | **Parcial, registrado.** `jev` vale como off com `AUTHORITY_REF_ABSENT`, sem chamada de rede. A reavaliação real fica para quando houver Authority Ref durável (DP-7). |
| NIT: `..policy.json` recusado | **Corrigido**, com teste. |
| NIT: `json_parse` vaza conteúdo no Redmine | **Corrigido** no caminho de roteamento (só o tipo do erro). O caminho sombra da S3 não mudou. |
| NIT: conta resolvida duas vezes; `routing-settings.json` em `_dom06` | **Aceito.** Com a SP-1 revista o caminho roda em produção; o custo é uma leitura a mais por despacho, sem efeito externo. |
| Testes: AC-02 sem teste no watcher; golden só cobre argv/env; sem E2E real ON | **Registrado.** O despacho roteado não é alcançável em produção (SP-1) e não há porta dos fundos (AD-5), por isso AC-02, AC-06 e AC-08 ficam como **só em unidade** na matriz da T10. Uma comparação de arquivos no golden fica como sugestão: exigiria regerar o golden na revisão base. |

- [x] Depois das correções, no Node 22: scripts 1241 pass / 0 fail / 6 skip, com o golden inalterado; dashboard 298/0; `check:js`, `lint:src` e `arch:check` limpos. `routing-admission-watcher.test.js` 12/12; `claude-account.test.js` 14/14; `routing-run.test.js` 21/21; `model-routing.test.js` 40/40; `routing-config.test.js` 29/29; `cost-tracking.test.js` 30/30.
- [ ] Revisão independente intermediária (Claude) do diff no escritor de Attempt e no watcher
- [ ] Richard decide a P-2 antes da T8

### Testes instáveis do watcher (corrigidos em 2026-11-06)

**Diagnóstico:** a instabilidade é **anterior à S4**. Sem os dois testes de watcher da S4, o `churn-detector` ainda falhou em 1 de 4 rodadas completas. Os testes da S4 aumentavam a frequência, porque acrescentam carga. Todas as falhas eram corridas entre o agente falso ou o próprio teste e as escritas do watcher no `state.json`. Em uso real essas corridas não acontecem: o agente real leva segundos até a primeira escrita e grava antes de sair.

| Teste | Corrida | Correção (só no teste; nenhuma asserção mudou) |
| -- | -- | -- |
| `churn-detector` "CHURN_THRESHOLD=2" | `agentRound` gravava entre as duas escritas do wrapper destacado (`releaseNode`, depois `recordNodeExit`); a segunda sobrescrevia o history (log: "1 rodada(s) analisada(s)") | `agentRound` espera o wrapper terminar: status fora de `running` e todo `node_start` com seu `node_end`/`node_error` |
| `node-events` "ciclo completo…" | o agente falso gravava antes do `recordAgentPid` do watcher (lê, roda `ps`, regrava), que sobrescrevia o avanço de nó (review despachado duas vezes) | o agente falso espera o `agent_pid` registrado (teto de 10 s) |
| `transcript-writer` "ciclo de 4 nós…" | a mesma do `node-events` (`'test' !== 'verify'`) | a mesma |
| `cost-tracking` (298/299/303) | a mesma no avanço de nó; e o `waitFor` de 5 s estourava sob carga | a mesma, e teto de 30 s (igual ao `dom06-dispatch-env`) |
| `node-lease` (hook `after`) | o `rmSync` corria com o wrapper ainda gravando (`ENOTEMPTY`) | `rmSync` com `maxRetries: 20, retryDelay: 100` |

**Medição (Node 22, suíte scripts completa):** antes, 4 de 13 rodadas com falha nesta sessão. Depois das correções, 9 de 10 verdes: a única falha foi o `transcript-writer`, corrigido em seguida, e as 5 rodadas seguintes saíram verdes. Node 24: scripts 1241/0 e dashboard 299/0.

**Risco remanescente (fora do escopo):** a mesma janela entre `recordAgentPid` e uma escrita imediata do agente existe no código de produção. Só seria atingida por um agente que gravasse o state em milissegundos. Fica registrada como observação, sem mudança no watcher.

### 2ª revisão independente (Claude, depois da SP-1 revista, 2026-11-06)

| Achado | O que foi feito |
| -- | -- |
| MAJOR-1: aviso de bloqueio repetido ou marcado como enviado sem certeza | **Corrigido.** Entrega com três resultados: enviado, falha certa (503/429/4xx/erro de rede certo, até 5 tentativas e `notice_failed_at`) e incerto (antes de reenviar, procura o token `[aviso-roteamento …]` nos journals; nunca repete efeito incerto, regra 5 do AGENTS.md). Testes no watcher para PUT incerto e 503. |
| MAJOR-2: ticket novo criava branch e worktree antes de recusar | **Corrigido.** Avaliação só por leitura no pré-teste (`evaluatePluginProof`); prova completa depois do worktree. |
| MINOR-1: limite D-4 lido depois de escritas do próprio tick | **Corrigido.** O limite usa `stateReadAt`, capturado no início do despacho. |
| MINOR-2: ponteiro de admissão velho com tarefa OFF anterior | **Pendente, registrado.** |
| MINOR-3: override inelegível só recusada na resolução | **Corrigido.** `recordRoutingOverride` carrega o snapshot e recusa com `OVERRIDE_INELIGIBLE` (modelo fora do `eligible_set`, esforço fora do `effort_map`) ou `ROUTING_UNVERIFIABLE`. |
| MINOR-4: fontes managed limitadas a 2 caminhos | **Pendente, registrado.** |
| MINOR-5: ticket novo recusado não aparece no Dashboard | **Pendente, registrado.** O aviso sai no Redmine e na notificação local. |
| MINOR-6: docs e comentários desatualizados | **Corrigido** (matriz de evidência, este arquivo, comentário da T7 no watcher). |
| NIT: `effort_applied` calculado tarde | **Corrigido.** |
| Pedido: teste real do CLI | **Feito.** 1ª rodada: skill solta no projeto. 2ª rodada: plugin de marketplace, skill na conta e o router real como plugin em pasta na conta `personal`. A 2ª rodada corrigiu a regra de `pluginConfigs`: só com `options` é neutralizável. Ver AC-08 em `tasks/evidence.md`. |

## Fase 3: override, visibilidade e fechamento

## Tarefa 8: override humano (P-2 aprovada pelo Richard em 2026-11-06: opção a)

**Descrição:** ler as overrides do writer escolhido na P-2 e aplicar a precedência
subtarefa > nó > ticket, valendo a partir do próximo limite de nó, na mesma Run e
com o snapshot intacto (D-4). `override_ref { quem, quando, escopo, valor }` na
RoutingDecision. Override inelegível → `PROVIDER_NOT_ELIGIBLE`, nunca troca
silenciosa.

**Critérios de aceite:**
- [x] A precedência e a vigência têm testes: override gravada no meio de um nó não altera o retry daquele nó (D-4; o limite é o 1º `node_start` da visita, `routing-run.nodeVisitStart`), e a gravada antes vale (AC-09).
- [x] O escopo subtarefa só casa com `subtask_key` presente (resolver, já coberto na T3); na S4 não há `subtask_key` no Attempt.
- [x] Canal e writer: os da P-2. `authorization.recordRoutingOverride` grava `state.routing_overrides[]` (append-only, com quem/quando/escopo/valor e evento `routing_override`) pelo `POST /api/runs/:taskId/routing-override`, com aprovador autenticado, CAS e `operation_id` idempotente, sem mudar status ou nó. É recusado para Run OFF (`ROUTING_OFF`), entrada inválida e nó rodando. O schema do state documenta o campo.

**Verificação (2026-11-06):** `authorization.test.js` 35/35; `authorization-api.test.js` 14/14; `routing-run.test.js` 25/25; `routing-admission-watcher.test.js` 15/15. Node 22: scripts 1257/0, dashboard 301/0; `check:js` (scripts e dashboard), `lint:src` e `arch:check` limpos. **Ainda não existe:** formulário no Dashboard (só a API) e revogação de override.

**Verificação:**
- [ ] `node --test scripts/lib/model-routing.test.js` + o teste do writer escolhido

**Dependências:** T7, decisão P-2.
**Arquivos:** a definir pela P-2 (estimativa: 3 a 4).
**Tamanho:** M. **ACs do SPEC:** AC-09.

## Tarefa 9: bloqueio de admissão visível no Dashboard

**Descrição:** reusar a tela que já mostra pendências e bloqueios humanos para
listar o bloqueio de admissão por projeto (causa, sha esperado e observado,
saída `mode: OFF`), lendo o marcador da T6. Sem tela nova.

**Critérios de aceite:**
- [x] O teste de API do dashboard devolve o bloqueio quando o marcador existe e nada quando ele não existe. Cada ticket barrado sem run vira uma pré-task sintética `<ticket>-spec-gate`, `blocked` (status `needs_human_review`) e só leitura, com `routingBlocked { scope, cause, detail, transient, firstBlockedAt, notifiedAt, configFile }`. Ticket com run real não duplica, e marcador malformado não inventa run.
- [x] A suíte do dashboard passa.
- [x] Lista: badge "⚠ ADMISSÃO BLOQUEADA" com o estilo existente (`qa-blocked-badge`, sem CSS novo), com a causa e a saída no tooltip. O "▶ Disparar" passa a explicar `routing_admission_blocked` e `routing_not_started`.

**Verificação (2026-11-06):**
- [x] Node 22: dashboard 299 pass / 0 fail; `check:js` do dashboard limpo. O render do badge foi conferido fora do repo, porque o retry QA também não tem teste de UI.
- **Fora da T9:** a Run admitida que parou em `NOT_STARTED` (T7) aparece como `blocked` comum. O motivo fica no `agent_log` e no Attempt DOM06, mas o Dashboard ainda não mostra um badge específico para ela.

**Dependências:** T6.
**Arquivos:** `dashboard/server.js` ou o módulo da rota existente, `public/` correspondente, teste de API.
**Tamanho:** S. **ACs do SPEC:** diretriz R-6 n.º 7.

## Tarefa 10: verificação completa, evidência e handoff

**Descrição:** rodar a receita oficial (`prisma-tests`), juntar a evidência por
AC, atribuída ao SHA da PR, conduzir a Review independente (Claude) e o 2º
revisor (Arquiteto), e entregar o handoff a partir de
`templates/handoff.yaml.template`.

**Critérios de aceite:**
- [x] Matriz AC-01 a AC-13 em [evidence.md](evidence.md), na revisão `ea9e42d`: 9 automatizados (AC-11 parcial), 3 só em unidade (AC-02/06/08) e 1 pendente (AC-09). Nada foi declarado como aceito.
- [x] Nenhum teste removido ou pulado. Os testes existentes que mudaram estão listados no AC-13 (contagem de regras e 5 correções de corrida, sem asserção alterada).
- [x] Handoff `PARTIAL` em `~/Workspace/prisma-evidence/2026-11-06-pri-233/handoff.yaml`: `validate-handoff.js --check-paths --base <worktree>` = VÁLIDO; `--pre-done` = exit 3 (o Done depende do Richard). Logs e TAPs no mesmo diretório.
- [ ] Verify, revisão Codex (G3), PR Draft: pendentes (ver evidence.md).

**Verificação:**
- [ ] `cd scripts && npm test && npm run check:js && npm run arch:check && npm run lint:src`
- [ ] `cd dashboard && npm test`

**Dependências:** T1 a T9 (ou T8 adiada por decisão explícita).
**Tamanho:** S.

### Checkpoint final
- [ ] AC-01 a AC-13 atendidos com evidência anexada à PRI-233
- [ ] Review + 2º revisor sem bloqueio; merge pelo Richard
