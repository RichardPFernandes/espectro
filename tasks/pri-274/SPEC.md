# Spec: PRI-274 c2b-4-content. Conteúdo §6.1–6.4, taxonomia 0.1, `recommendation` e `platform_signals`

> **Status:** r1, aguarda aceite do Richard. Nível **Médio** (rótulo aplicado em 14/11): só roda atrás de
> `WATCHER_QA_DIAGNOSTICO`, que segue desligada; nada muda no consumidor. Bump, readback e ligar a flag são
> atos Alto separados, cada um com AUTORIZO próprio.
> Contrato: `sdd-B-v3.md` §6.1–6.4, INV-4/5/6; QRD-AC-07, 08, 09, 11. Depende de `c2b-1-model` (PRI-272,
> mergeada) e vem depois da `c2b-2` (PRI-273, mergeada). **Se esta spec divergir da SDD, vale a SDD.**
> Base: `main` `a2e956b`. Fonte da SDD: `~/Workspace/prisma-evidence/pri-181/sdd-B-v3.md`.

## Objetivo

A c2b-1 valida só o cabeçalho de `vNNN.json`; `context`, `assertions`, `cause`, `recommendation` e
`platform_signals` são aceitas **sem validação** (`qa-diagnosis-model.js`, `CONTENT_KEYS`). A condição (e) do
§4.3.1 só fica completa com esta fatia. Entrega: o validador do conteúdo, a taxonomia exata e as regras que
impedem FACT sem predicado de sistema. Sucesso: uma versão com conteúdo fora do contrato não publica; uma
versão sem evidência publica com `missing[]` e causa UNKNOWN (INV-4).

## Escopo

**Inclui**
- `validateContent` chamado por `validateVersion`; seções ausentes continuam permitidas só onde a SDD permite.
- **§6.1** `context.sources[]` (`id, kind, locator, sha256|null, version_binding, trust, admitted,
  admission_rule, captured_at`) com `trust` e `kind` fechados; `context.missing[]` (`what, why_needed, blocks[]`).
- **§6.2** `assertions[]` (`id, type, basis, predicate_ref|null, evidence_ids[], contradicted_by[],
  statement_ref`). Regra: `type: FACT` ⇔ `basis: SYSTEM_PREDICATE` com `predicate_ref` `pred:<id>@<ver>` sobre
  fonte `TRUSTED_SYSTEM` e `admitted: true`. `REPORTED`→REPORT, `AGENT_INFERENCE`→HYPOTHESIS,
  `HUMAN_ADJUDICATED`→ADJUDICATION; nenhuma delas vira FACT (QRD-AC-11).
- **§6.3** `taxonomy qa-cause-taxonomy/0.1`: as 11 categorias exatas da SDD (`code, requirement_spec, test,
  environment, data, configuration, db_migration, integration, already_resolved, invalid_rejection,
  indeterminate`). `cause.status ∈ {HYPOTHESES, UNKNOWN, HUMAN_CONFIRMED}`; `support ∈ {MODERATE, WEAK,
  UNKNOWN}`, nunca acima de MODERATE, sem soma a 100%; `UNKNOWN` sem categoria default.
- **§6.4** `recommendation` (`action`, `rationale_ref`, `depends_on_missing[]`, `human_gate_required`
  **literal `true`**, `route_hint`), vocabulários fechados. Nenhum campo concede ou pré-preenche autorização (INV-1).
- `platform_signals[]` separados de `cause` (QRD-AC-08).
- Substitui o `qa-diagnosis-taxonomy.js` antigo (13 categorias, entre elas `identity`, `ingestion`,
  `database_migration`, `information_absent`) pelo da SDD.
- Retira ou adapta os módulos C2/C3 (decidido na c2b-2 Q6, A): `-analyze`, `-collect`, `-predicates`,
  `-publish`, `-layout`, `-record`, e a linha de log `LIGADO (C1–C3)`, com os testes que os importam.

**Não inclui:** protocolo e estados (c2b-2); movers e clones (c2b-3); ingestão (c1b); revisão e
`confirmed_cause` (c5, §6.5); outcome e export (c6); analisador por agente (C4); `bindings.commit` (RC-3);
calibração numérica do `support` (PRI-86/80); ligar a flag, bump, readback.

## Comandos

```
Dirigido:  node --test scripts/lib/qa-diagnosis-model.test.js scripts/lib/qa-diagnosis-taxonomy.test.js scripts/lib/qa-diagnosis-content.test.js
Suíte:     cd scripts && npm test    # harness/run-tests.js; receita oficial no skill prisma-tests
```

## Estrutura

```
scripts/lib/qa-diagnosis-model.js          validateVersion chama validateContent
scripts/lib/qa-diagnosis-content.js        NOVO: validateContent, vocabulários, regras FACT e support
scripts/lib/qa-diagnosis-taxonomy.js       reescrito: qa-cause-taxonomy/0.1 exata
scripts/lib/qa-diagnosis-*.test.js         testes por AC; retirados os dos módulos removidos
tasks/pri-274/SPEC.md                      esta spec
```

## Estilo

JavaScript puro, sem ajv (como a c2b-1: condição (e) não pode passar por falta de validador). Sem I/O, sem
escrita de state. Erros acumulados em `errors[]`, chaves fechadas, vocabulários em `Object.freeze`:

```js
if (a.type === 'FACT' && !(a.basis === 'SYSTEM_PREDICATE' && PRED_RE.test(a.predicate_ref))) errors.push(`assertions[${i}]: FACT sem predicado de sistema`);
```

## Testes

`node:test`, fixtures sintéticas (sem dado corporativo). Um teste por AC, mais mutação nas regras de FACT.

- **AC-01 (QRD-AC-07):** sem spec/nota/journal → versão válida com `missing[]`, hipóteses WEAK/UNKNOWN, nenhuma
  categoria por default.
- **AC-02 (QRD-AC-08):** fixtures #43782/#43608 sintéticas → preparação bloqueada em `platform_signals`; causa
  de produto UNKNOWN sem rótulo humano.
- **AC-03 (QRD-AC-09):** #42359 sintética → `db_migration` no máximo MODERATE; `request_effect`,
  `human_gate_required=true`; nenhum `pending_authorization`, nenhum despacho.
- **AC-04 (QRD-AC-11):** citação íntegra de afirmação falsa e nota que manda declarar FACT não produzem FACT;
  só `SYSTEM_PREDICATE` produz; adjudicação humana é ADJUDICATION; JSON fora do schema não publica.
- **AC-05:** taxonomia = exatamente as 11 categorias; `support` acima de MODERATE, `human_gate_required:false`
  e `action`/`route_hint` fora do vocabulário são recusados.
- **AC-06:** flag desligada → nenhum `vNNN.json` criado e os oráculos C0/c2b-1/c2b-2 verdes sem edição de
  expectativa (só retirada dos testes dos módulos removidos).

## Limites

- **Sempre:** flag desligada; PR em draft; "Refs PRI-274", nunca "Fixes"; FACT só por predicado de sistema;
  UNKNOWN é `null`/`UNKNOWN`, nunca zero ou categoria padrão.
- **Perguntar antes:** mexer em `state.schema.json`; adicionar dependência; mudar API de `qa-diagnosis-protocol.js`.
- **Nunca:** gravar `state.json` fora do state-writer; conteúdo corporativo em fixture; criar efeito, gate ou
  autorização a partir do diagnóstico; ligar flag ou fazer bump.

## Perguntas abertas (com recomendação)

1. **Forma de `platform_signals[]`.** A SDD só diz «preparação bloqueada, spec ausente», separados da causa;
   não define campos. *Recomendo:* `{ id, kind ∈ {preparation_blocked, spec_missing}, evidence_ids[],
   admitted }`, conjunto fechado, nomeado como delta a registrar na SDD.
2. **Regra de compatibilidade do `support` MODERATE** («regra versionada», `rules_version`). A SDD não traz a
   tabela. *Recomendo:* `rules/0.1` mínima, só com os predicados de exemplo do §6.2 e o necessário ao AC-03.
3. **Módulos C2/C3: retirar ou adaptar `-predicates`.** *Recomendo:* adaptar `-predicates` para emitir
   assertions `pred:<id>@<ver>` e retirar o resto. Confirmo os usos de `-layout` e `-publish` no código antes.
4. **Taxonomia antiga (13 categorias) × SDD (11).** Os nomes diferem (`database_migration`×`db_migration`).
   *Recomendo:* a SDD vale, o módulo antigo sai sem alias.
