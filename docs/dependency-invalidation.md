> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.

# Dependency Invalidation — artefatos derivados da Spec

Quando uma SPEC_CHANGE aprovada muda o contrato, tudo o que foi produzido antes deixa de
comprovar o contrato atual. Este documento descreve como isso é decidido e marcado, de
forma **centralizada e explícita**.

- Código: `scripts/invalidate.js` (único módulo que decide validade)
- Testes: `scripts/invalidate.test.js` (casos funcionais), `scripts/invalidate-concurrency.test.js`
  (R1–R7, intercalações forçadas passo a passo) e `dashboard/validity-api.test.js`
- Schemas: `.graph/schemas/state.schema.json` (`artifact_validity`, `execution_spec`,
  `invalidations`, `pending_invalidation` [formato antigo], `definitions.validity`) e
  `.graph/schemas/acceptance-evidence.schema.json` (`validity`)
- Pré-requisitos: spec_hash e drift (`docs/spec-versioning.md`, `scripts/lib/spec-authority.js`),
  governança de SPEC_CHANGE (`scripts/lib/spec-change.js`), versionamento
  (`scripts/lib/spec-version.js`), provenance (`docs/ac-provenance.md`)

## 1. Dependency chain

```
SPEC (spec_hash / spec_version)
 └─▶ PLAN            plan.md                      carimbo: spec-authority baseline (/plan)
      └─▶ IMPLEMENTATION  diff do worktree         carimbo: portão de drift do /implement
           └─▶ REVIEW      review-result.md         carimbo: review-result.js record
                └─▶ EVIDENCE acceptance-evidence.json carimbo: acceptance-evidence.js finalize (/test)
                     └─▶ VERIFY spec-conformance.md    carimbo: spec-authority verify --write
```

## 2. Estados de validade

```json
{ "validity": { "status": "VALID | STALE | UNKNOWN", "stale_since_version": 2, "stale_acs": [] } }
```

| Status | Quando |
|---|---|
| `VALID` | produzido contra a spec atual, **por uma execução governada por ela**, sem transição de contrato pendente |
| `STALE` | produzido contra outra versão; invalidado por SPEC_CHANGE aprovada; produzido por execução que começou sob outro contrato; ou carimbado com transição pendente |
| `UNKNOWN` | artefato legado sem spec_hash ("legado sem versão") |

- **UNKNOWN não é FAIL**, mas evidence UNKNOWN não comprova a spec atual. Por isso o
  Verify é **fail-closed** e reprova (`EVIDENCE_SPEC_UNKNOWN`). Isso vale também para run
  legado só com `ac-evidence.md`, que antes passava só com aviso. Nada é reescrito para
  ganhar hash retroativamente.
- `stale_acs[]` está sempre presente e vazio na v1. O schema já aceita `AC-NN`.
- **STALE é pegajoso**: `refresh()` só rebaixa (VALID → STALE). Só `stampProduced()` (o nó
  produzindo de novo) devolve VALID.

Onde fica (as fases **leem**; nenhuma recalcula hash):

| Artefato | Registro | Espelho |
|---|---|---|
| Plan | `state.artifact_validity.plan` | — |
| Implementation | `state.artifact_validity.implement` | — |
| Review | `state.artifact_validity.review` | `state.review_results.validity` |
| Evidence | `state.artifact_validity.evidence` | `acceptance-evidence.json` → `validity` |
| Verify | `state.artifact_validity.verify` | `state.spec_conformance.validity` |

Cada registro guarda também `execution_spec_hash` (a spec que governou a execução que o
produziu) e `stale_reason`.

## 3. Lógica de invalidação centralizada

**INV-SPEC-CHANGE-REPLAN** — *an approved SPEC_CHANGE always requires re-entry through
Plan. Hash equality MUST NOT be used as proof that replanning is unnecessary.*

`invalidateDerivedArtifacts(oldSpec, newSpec, runState, { cause, transitionId })` é a
única função que decide invalidar:

- `cause = "spec_change_approved"` → **sempre** invalida (Plan, Implementation, Review,
  evidence e Verify STALE; `stale_acs` vazio = invalidação total), com hash igual ou
  não. Hash igual só significa que a `spec_version` não incrementa
  (`spec-version.bump` → `hash_scope_unchanged`) e fica registrado como
  `hash_scope_changed: false`.
- Outras causas (replay, `apply` manual) → invalida só se o hash mudou.
- Idempotente por `transition_id` (ex.: `SC-001@<task>`, `manual-approval:<hash12>`,
  `replay:<a>→<b>`): a mesma transição nunca é aplicada duas vezes.

Por que hash igual não basta: `applyToSpec` só altera seções incluídas no hash quando a
proposta traz `ac_changes`. Regra de negócio, restrição, escopo e exceção aprovadas vão só
para `## Histórico de Mudanças`, que fica fora do HASH_SCOPE. E as fases leem seções fora
do hash: o `/plan` lê o Histórico ao replanejar, e implement, review e verify leem
`## Decisões de Implementação`. Redefinir o HASH_SCOPE semanticamente é uma evolução
separada.

## 4. Transições e concorrência

### Identidade da transição e journal

Uma transição de contrato pendente para um run fica em
`memory/runs/<task-id>/pending-invalidation.jsonl`:
- uma linha por transição (`transition_id`, `cause`, hashes e versões, `case`, `phase`,
  `registered_at`);
- é **append-only** (`O_APPEND`, nunca read-modify-write), nunca é apagada nem reescrita;
- é consumida quando o `transition_id` aparece em `state.invalidations[]`.

`pendingTransitions(state, runDir)` = journal − consumidas (+ o formato antigo
`state.pending_invalidation`, ainda lido e nunca gravado).

A pendência fica **fora** do `state.json` de propósito. CLIs dentro do nó (`baseline`,
`finalize`, `record`, `verify --write`) fazem read-modify-write do `state.json`. Uma
pendência gravada ali entre a leitura e a escrita delas se perdia (**corrida 1**). Nenhum
escritor do `state.json` toca o journal.

### Ordem da aprovação (corrida 2)

`approveSpecChange`:
1. calcula a spec nova em memória (`applyToSpec`) e o hash novo;
2. registra a transição nos **outros** runs ativos do mesmo checkout que usam a mesma spec
   (`propagateSpecChange`). Nenhum run é pulado por já ter o hash novo, porque ter
   observado a v2 não é ter participado da transição. A versão nova vem de
   `predictVersion`, a mesma conta que `spec-version.bump` faz;
3. só então grava a spec nova no disco, a versão e o run que aprovou.

Um run que ler a v2 depois do passo 3 já tem a transição registrada.

### execution_spec ≠ spec atual no fim

Cada despacho grava `state.execution_spec = { node, spec_hash, spec_version, started_at }`:
- é a spec **no disco** quando o nó começou;
- é gravada pelo watcher, na mesma escrita do lease (`nodeLease.acquireNode(..., { extra })`);
- em execução manual, quem grava é o portão de drift dentro do nó (implement, review,
  test, verify) ou, no `/plan`, o passo `node "$PRISMA_ROOT/scripts/invalidate.js" begin <run> --node=plan`.
  Esses dois só substituem uma `execution_spec` de outro nó ou que começou antes da
  última invalidação (execução nova); a de uma execução em curso fica.

`stampProduced` só carimba VALID se:
1. o hash do artefato é o da spec atual do run; **e**
2. a `execution_spec` do nó produtor tem esse mesmo hash; **e**
3. essa execução começou **depois** da última invalidação do run; **e**
4. não há transição pendente no journal.

Uma execução v1 que termina com a v2 no disco nunca vira VALID(v2). A invalidação **não**
apaga a `execution_spec`: um nó manual (sem lease, `status: in_progress`, tratado como
ocioso e invalidado na hora) ainda vai carimbar, e é ela que prova que ele começou antes
da invalidação. O mesmo vale para a janela entre o despacho e o lease do watcher. A regra
3 é a que segura o caso de hash igual (INV), em que a regra 2 não vê diferença.

### Os três casos

| Caso | Situação | O que acontece |
|---|---|---|
| A | nenhum nó rodando | transição no journal **e** aplicada na hora no `state.json`: tudo STALE, `node = "plan"` |
| B | `implement`/`review`/`test`/`verify`/`commit` rodando | só o journal; o nó não é interrompido e o `state.json` dele não é tocado |
| C | `plan` rodando | idem B; o plano que essa execução carimbar sai STALE (pendência + `execution_spec`) |

Enquanto uma transição está pendente (B/C, ou o intervalo entre registro e aplicação):
- **Verify** recusa: `PENDING_SPEC_INVALIDATION`, antes de olhar qualquer evidence (não
  depende de `artifact_validity` já estar atualizado);
- **Commit** recusa, no início e de novo antes do `git commit` (`guard --phase=commit`);
- todo artefato carimbado sai STALE;
- o dashboard mostra STALE com a mensagem da transição pendente.

Fim do nó (sucesso ou falha): o watcher (`dispatchTicket` em `scripts/readmine-watcher.js`)
aplica `resolvePendingInvalidation` **antes de qualquer outro portão ou despacho**. Ela
faz quatro coisas:
- invalidação total;
- sincroniza `state.spec` com a versão nova;
- grava `spec_change_approved`/`spec_change_hash` para o portão de drift;
- define `node = "plan"`.

Com `node = "plan"`, o despacho normal roda `/plan`, com `invalidate.promptNote(state)` no
prompt. O grafo não muda.

### Commit em execução quando a transição chega

O `/commit` é despachado automaticamente (`NEVER_AUTO_DISPATCH` vazio). Antes desta
correção ele podia:
- commitar contra o contrato antigo;
- perder a pendência gravada no `state.json`;
- arquivar o run com pendência nunca aplicada.

Agora:
- o guard de commit recusa se a transição chegou antes do `git commit`;
- depois do `git commit`, o run já entregou contra a spec que o governou. Uma transição
  posterior é registrada como `closed` pelo `invalidate.js resolve` que o passo 9 do
  `/commit` roda depois de arquivar: os dados ficam marcados STALE e nada é reaberto;
- o journal vai junto para o `_archive/`, então nada se perde.

### Limites conhecidos

- Não há lock nem CAS no `state.json`. A correção não depende disso: a pendência vive no
  journal, que só recebe append. Um `state.json` sobrescrito por cópia antiga perde no
  máximo o registro de consumo, e a transição é reaplicada (conservador, idempotente para
  o resultado). CAS/versionamento do `state.json` é evolução separada.
- Em execução manual, um rerun do mesmo nó **sem** invalidação no meio reaproveita a
  `execution_spec` gravada antes. Se a spec mudou sem invalidação, o efeito é STALE a mais
  (lado seguro), nunca VALID a mais.
- `/plan` manual que pule o passo `begin` não tem `execution_spec` própria; o carimbo dele
  depende só das regras 1 e 4.
- Uma linha truncada no journal (crash no meio do append) é ignorada na leitura; o
  append seguinte pode colar nela. Observação do review, não corrigida nesta rodada.

## 5. Comportamento por fase

| Fase | Artefato STALE | UNKNOWN (legado) | Transição pendente |
|---|---|---|---|
| Plan | refaz do zero; o `baseline` carimba o plano novo | `baseline` carimba na primeira execução | carimbo sai STALE |
| Implement | — (o portão carimba no início do nó) | — | carimbo sai STALE |
| Review | alerta "Implement produzido contra Spec v{N}…" — não bloqueia; `compliance_valid: false` → `REVIEW_COMPLIANCE_NOT_VALID` no Verify | alerta "legado sem versão"; `compliance_valid: false` | alerta; não bloqueia |
| Test | `finalize` regrava a matriz; o CLI carimba e espelha `validity` | idem | carimbo sai STALE |
| Verify | **recusa** `EVIDENCE_SPEC_STALE` ("Evidence produzida contra Spec v{N}, Spec atual é v{M}. Execute novo ciclo." / "invalidada por SPEC_CHANGE aprovada") | **recusa** `EVIDENCE_SPEC_UNKNOWN` | **recusa** `PENDING_SPEC_INVALIDATION` |
| Commit | — | — | **recusa** `PENDING_SPEC_INVALIDATION` |
| Dashboard | badge `⚠ STALE` + mensagem por AC/nó | "legado sem versão" | STALE com a transição pendente |

Review não é portão de validade: o veredito e a aresta dele vêm do `review-result.js`. O
portão é o Verify.

### Replay

O replay usa a Spec **ativa** (`checkReplay`):
- spec ativa diferente da do run original → invalidação total, recomeça no **plan**;
- matriz de outra versão → STALE, recomeça no **test**;
- matriz sem `spec_hash` → UNKNOWN + aviso "Evidence legada sem versão — não comprova
  Spec atual.", recomeça no **test**.

O run original fica intacto.

### Dashboard

`GET /api/runs/:taskId` (campo `validity`) e `GET /api/runs/:taskId/validity`
(`invalidate.describe`) entregam:
- `phases`, `nodes` (badge do trilho) e `acs` (mensagem por AC);
- `pending_invalidation`: as transições pendentes do journal;
- `execution_spec` e `last_invalidation`.

A resposta passa por `redactDeep`: só hashes abreviados, versões e status.

## 6. CLI

```bash
node "$PRISMA_ROOT/scripts/invalidate.js" status  memory/runs/<task-id> [--json]
node "$PRISMA_ROOT/scripts/invalidate.js" guard   memory/runs/<task-id> --phase=verify   # exit 1 = STALE/UNKNOWN/pendente
node "$PRISMA_ROOT/scripts/invalidate.js" guard   memory/runs/<task-id> --phase=commit   # exit 1 = transição pendente
node "$PRISMA_ROOT/scripts/invalidate.js" guard   memory/runs/<task-id> --phase=review   # alerta, exit 0
node "$PRISMA_ROOT/scripts/invalidate.js" apply   memory/runs/<task-id> --new-hash=<h> [--new-version=N] [--by=<quem>]
node "$PRISMA_ROOT/scripts/invalidate.js" resolve memory/runs/<task-id>
node "$PRISMA_ROOT/scripts/invalidate.js" begin   memory/runs/<task-id> --node=plan      # execution_spec de execução manual
```

## 7. Autoridade de validade × mecanismos de suporte

| Regra | Tipo | Onde fica |
|---|---|---|
| Comparar hash do artefato com a spec (`classify`) | A — autoridade | `invalidate.js` |
| O que invalidar e quando (INV, casos A/B/C, idempotência por `transition_id`) | A | `invalidate.js` (`invalidateDerivedArtifacts`, `applySpecChange`, `resolvePendingInvalidation`) |
| VALID no carimbo (spec atual + `execution_spec` iniciada depois da última invalidação + sem pendência) | A | `invalidate.js` (`stampProduced`) |
| Arquivo de `stale_artifacts` regerado? | A | `invalidate.js` (`isRegenerated`); `spec-change.refreshStale` só aplica |
| Validade da matriz no arquivo | A | antes decidida em `finalize`; agora `stampProduced` + `syncEvidenceFile` |
| Aprovação manual de drift → invalidar uma vez | A | antes comparava hash em `spec-authority`; agora `transition_id` no resolver |
| Validade do Review no Verify | A | antes combinada em `verifyConformance`; agora `invalidate.effectiveStatus` |
| Verify/Commit/Review recusar ou alertar | B — suporte | `spec-authority`, `acceptance-evidence.checkMatrix`, templates — chamam `guardVerify`/`guardPending`/`guardReview` |
| Drift da spec (arquivo × baseline do Plan) | B | `spec-authority.checkDrift` — integridade da spec, não validade de artefato |
| Rótulo de versão (`stampFor`, `checkArtifacts`: `SPEC_CHANGE_MID_RUN`, `SPEC_VERSION_MISMATCH`) | B | `spec-version` — consistência do rótulo de versão; a comparação de hash usa `classify` |
| `staleGate` (nó guardado volta ao Plan) | B | `spec-change` — executa a decisão de `isRegenerated` |
| Replay, dashboard, prompt | B | `cycle-replayer`, `dashboard/server.js`, watcher — consultam/apresentam |

## 8. Mudanças de comportamento

- **Toda** SPEC_CHANGE aprovada volta ao `/plan` e invalida os artefatos, inclusive com
  HASH_SCOPE inalterado (INV-SPEC-CHANGE-REPLAN — é a política vigente de
  `memory/decisions/2026-09-30-governanca-spec-change.md`, agora explícita).
- **Aprovação manual de drift** que muda o contrato invalida os artefatos e volta ao `/plan`.
- **Run legado só com `ac-evidence.md`** reprova no Verify (`EVIDENCE_SPEC_UNKNOWN`).
- **Reescrever `plan.md`/`acceptance-evidence.json` à mão não tira o arquivo de
  `stale_artifacts`**: precisa do carimbo do nó (`baseline` / `finalize`).
- **Verify e Commit** recusam com transição pendente (`PENDING_SPEC_INVALIDATION`).

## 9. Evolução: granularidade por AC-ID (não implementada)

1. Diff por AC: estender `spec-hash.fingerprint` para hash por AC e comparar v1 × v2.
   Mudança fora de AC continua invalidando tudo, e mudança fora do HASH_SCOPE continua
   exigindo replanejamento (INV).
2. Mapa AC → artefato: plan (`## Cobertura dos ACs`), matriz (`coverage`, `implementation`),
   review (`spec_compliance.acs`) já são indexados por AC-ID.
3. `invalidateDerivedArtifacts` preenche `stale_acs`; o `/test` refaz só esses ACs.
4. `describe().acs[].validity` por AC.
