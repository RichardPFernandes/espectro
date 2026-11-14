# Tarefas: PRI-274 c2b-4-content

> Fonte: [SPEC.md](SPEC.md) e [plan.md](plan.md). TDD: o teste nasce falhando.
> Foco: `node --test scripts/lib/<arquivo>.test.js`. Suíte: `cd scripts && npm test`.
> **Nada começa antes do aceite da SPEC e do AUTORIZO D-C2b-4.**

## Fase 0: tirar o código morto

- [ ] **T1: retirar C2/C3 não usado pelo protocolo novo** (M, deleção mecânica)
  - Confirmar por grep que o watcher não chama `analyzeRejection`/`publishDiagnosisRecord`.
  - Remover `-layout`, `-record`, `-collect`, `-analyze`, `-publish` e seus testes; ajustar `spied` em
    `qa-diagnosis-c2b1-flag-on/off.test.js` e o `require` em `qa-diagnostico-flag.test.js:54`; trocar o texto
    `LIGADO (C1–C3)` (`readmine-watcher.js:6004`).
  - Aceite: nenhuma expectativa de oráculo muda; flag ligada e desligada continuam com o mesmo comportamento.
  - Verificar: `node --test scripts/lib/qa-diagnosis-c2b*-flag-*.test.js scripts/lib/qa-diagnostico-flag.test.js`, depois `npm test`.
  - Depende de: Q3 (default A). Arquivos: ~14 removidos, 4 editados.

- [ ] **T2: taxonomia exata e `predicates` como assertions** (M)
  - `qa-diagnosis-taxonomy.js` com as 11 categorias da SDD, `qa-cause-taxonomy/0.1`, sem alias.
  - `-predicates` emite `{ predicate_ref: 'pred:<id>@<ver>', ... }` só sobre fonte `TRUSTED_SYSTEM`.
  - Aceite: 11 categorias exatas; nenhum nome antigo (`identity`, `database_migration`...); AC-05 parte da taxonomia.
  - Verificar: `node --test scripts/lib/qa-diagnosis-taxonomy.test.js scripts/lib/qa-diagnosis-predicates.test.js`.
  - Depende de: T1, Q4. Arquivos: taxonomy, predicates e os 2 testes.

### Checkpoint: após T2
- [ ] Suíte verde; só `predicates` e `taxonomy` restam dos módulos antigos; revisar com o Richard.

## Fase 1: validador de conteúdo, seção a seção

- [ ] **T3: `validateContent` + §6.1 `context` e `missing[]`** (M) — AC-01 (QRD-AC-07)
  - Novo `qa-diagnosis-content.js`, chamado por `validateVersion`; `kind`/`trust` fechados; `missing[]` válido.
  - Aceite: versão sem spec/nota/journal valida com `missing[]` e sem categoria por default; `sources[]`
    malformado é recusado. Rodar antes `qa-diagnosis-protocol/store*.test.js` e consertar só fixtures de conteúdo.
  - Verificar: `node --test scripts/lib/qa-diagnosis-content.test.js scripts/lib/qa-diagnosis-model.test.js scripts/lib/qa-diagnosis-protocol.test.js scripts/lib/qa-diagnosis-store.test.js`.
  - Arquivos: content, model, content.test, + fixtures dos testes do protocolo/store.

- [ ] **T4: §6.2 `assertions` e regra de FACT** (M) — AC-04 (QRD-AC-11)
  - `type`×`basis` fechados; FACT ⇔ `SYSTEM_PREDICATE` com `pred:<id>@<ver>` sobre fonte `TRUSTED_SYSTEM` e
    `admitted:true`; `evidence_ids` precisam existir em `sources[]`.
  - Aceite: citação íntegra de afirmação falsa e nota que manda declarar FACT não viram FACT; adjudicação
    humana é ADJUDICATION; JSON fora do schema não valida.
  - Verificar: `node --test scripts/lib/qa-diagnosis-content.test.js` + mutação na regra (remover o teste de
    `basis` deve fazer um teste falhar).

### Checkpoint: após T4
- [ ] FACT só por predicado de sistema, provado por mutação; suíte verde.

- [ ] **T5: §6.3 `cause`, `support` e `rules/0.1`** (M) — AC-02 parcial, AC-03 parcial
  - `cause.status`, hipóteses por categoria exata, `support ∈ {MODERATE,WEAK,UNKNOWN}`; MODERATE só com ≥1
    FACT compatível por `rules/0.1` e nenhum FACT contrário; sem soma a 100%; `UNKNOWN` sem categoria.
  - Aceite: `db_migration` sobe no máximo a MODERATE; causa de produto fica UNKNOWN sem rótulo humano.
  - Verificar: `node --test scripts/lib/qa-diagnosis-content.test.js`.
  - Depende de: T4, Q2. Arquivos: content, rules (novo, pequeno), content.test.

- [ ] **T6: §6.4 `recommendation` e `platform_signals`** (M) — AC-02, AC-03 (QRD-AC-08, 09)
  - Vocabulários fechados de `action` e `route_hint`; `human_gate_required` literal `true`; `platform_signals`
    separados de `cause` (forma da Q1).
  - Aceite: #43782/#43608 → preparação bloqueada em `platform_signals`, causa de produto UNKNOWN; #42359 →
    `request_effect`, gate humano, nenhum `pending_authorization`, nenhum despacho.
  - Verificar: `node --test scripts/lib/qa-diagnosis-content.test.js`.
  - Depende de: T5, Q1. Arquivos: content, content.test.

### Checkpoint: após T6
- [ ] AC-01 a AC-04 verdes; Richard revisa antes de fechar.

## Fase 2: fechamento

- [ ] **T7: flag desligada, suíte completa e PR** (S) — AC-05, AC-06
  - Confirmar que nenhum `vNNN.json` é criado com a flag ausente; oráculos C0/c2b-1/c2b-2 verdes sem editar
    expectativa; `npm test` completo.
  - PR em draft com "Refs PRI-274", rótulo `processo:medio`, seção Evidência preenchida; pedir G3 (1 revisor).
  - Verificar: `cd scripts && npm test`; `processo-check` verde.
  - Depende de: T1–T6.

### Checkpoint: completo
- [ ] ACs da SPEC atendidos, PR em draft, G3 feito, AUTORIZO D-C2b-4 registrado. Merge é do Richard.
