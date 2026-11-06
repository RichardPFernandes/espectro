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
- [ ] Revisão independente intermediária (Claude) do diff no escritor de Attempt e no watcher
- [ ] Richard decide a P-2 antes da T8

## Fase 3: override, visibilidade e fechamento

## Tarefa 8: override humano (BLOQUEADA até a P-2)

**Descrição:** ler as overrides do writer escolhido na P-2 e aplicar a precedência
subtarefa > nó > ticket, valendo a partir do próximo limite de nó, na mesma Run e
com o snapshot intacto (D-4). `override_ref { quem, quando, escopo, valor }` na
RoutingDecision. Override inelegível → `PROVIDER_NOT_ELIGIBLE`, nunca troca
silenciosa.

**Critérios de aceite:**
- [ ] A precedência e a vigência têm testes: override gravado no meio de um nó não altera aquele Attempt e altera o seguinte (AC-09).
- [ ] O escopo subtarefa só casa com `subtask_key` presente; sem ele, não tem efeito e o motivo é registrado.
- [ ] Nenhum endpoint, arquivo de estado ou canal novo fora do que a P-2 decidir.

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
- [ ] O teste de API do dashboard devolve o bloqueio quando o marcador existe e nada quando ele não existe.
- [ ] A suíte do dashboard passa.

**Verificação:**
- [ ] `cd dashboard && npm test`

**Dependências:** T6.
**Arquivos:** `dashboard/server.js` ou o módulo da rota existente, `public/` correspondente, teste de API.
**Tamanho:** S. **ACs do SPEC:** diretriz R-6 n.º 7.

## Tarefa 10: verificação completa, evidência e handoff

**Descrição:** rodar a receita oficial (`prisma-tests`), juntar a evidência por
AC, atribuída ao SHA da PR, conduzir a Review independente (Claude) e o 2º
revisor (Arquiteto), e entregar o handoff a partir de
`templates/handoff.yaml.template`.

**Critérios de aceite:**
- [ ] Matriz AC-01 a AC-13 → teste e saída, sem UNKNOWN tratado como aprovado.
- [ ] Nenhum teste removido, pulado ou enfraquecido (diff de `*.test.js` revisado).
- [ ] Handoff validado por `node scripts/validate-handoff.js`.

**Verificação:**
- [ ] `cd scripts && npm test && npm run check:js && npm run arch:check && npm run lint:src`
- [ ] `cd dashboard && npm test`

**Dependências:** T1 a T9 (ou T8 adiada por decisão explícita).
**Tamanho:** S.

### Checkpoint final
- [ ] AC-01 a AC-13 atendidos com evidência anexada à PRI-233
- [ ] Review + 2º revisor sem bloqueio; merge pelo Richard
