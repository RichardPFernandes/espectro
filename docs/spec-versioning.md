> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.

# Versionamento formal da Spec

Toda spec de task tem duas identidades:

| Campo | O que é | Muda quando |
|---|---|---|
| `spec_version` | inteiro incremental (1, 2, 3…), a versão **humana/semântica** do contrato | **só** quando uma SPEC_CHANGE aprovada altera o HASH_SCOPE |
| `spec_hash` | SHA-256 do **conteúdo contratual** (HASH_SCOPE), a identidade **técnica exata** | quando qualquer coisa dentro do HASH_SCOPE muda |

O par `(spec_version, spec_hash)` identifica exatamente o contrato que um Plan, Review,
Test, Verify ou PR usou. Uma edição de comentário, formatação ou contexto não muda
nenhum dos dois: não pausa run em andamento (spec-drift) e não gera versão.

A topologia do grafo (`fetch-ticket → plan → implement → review → test → verify →
commit`) não muda. Não há nó, aresta ou portão novos, só campos e checagens dentro dos
existentes. Decisão e plano: `memory/decisions/2026-09-30-spec-versioning.md`.

## Ciclo de vida

```
/fetch-ticket ── spec criada do template ── spec-version.js init
                 state.spec = {version: 1, hash: H0, status: "draft"}
      │
      │  humano preenche Objetivo / Escopo / ACs (autoria — não é mudança de versão)
      ▼
/plan ────────── spec-authority.js baseline  →  SELA a v1
                 state.spec = {version: 1, hash: H1, status: "active"}
                 changelog.versions += {version: 1, hash: H1, reason: "initial"}
                 plan.md: "Spec: … · spec_version=1 · spec_hash=H1"
      │
      ▼
/implement ───── decisão muda requisito → spec-change.js record → SPEC_CHANGE SC-001
                 (pausa em spec-change-pending-approval; watcher publica no Redmine)
      │
      ├─ rejeitada ─→ spec-change-rejected, v1 e changelog intactos
      │
      └─ aprovada ──→ spec-change.js approveSpecChange
                      audit += entry "approved" (entry-N)
                      spec reescrita (AC novo/removido + Histórico de Mudanças)
                      HASH_SCOPE mudou?  sim → v2: changelog.versions += {version: 2,
                                               approval_ref: "spec-change-audit.json#entry-N",
                                               diff_summary: "AC-04 adicionado"}
                                         não → v1 mantida (evento spec_version_unchanged)
                      plan.md / handoff.md / acceptance-evidence.json stale → volta ao /plan
      ▼
/plan (replan) ── baseline: v2 já é a vigente; plan.md declara spec_version=2
/review ───────── review_results.spec_version = 2, spec_hash = H2
/test ─────────── acceptance-evidence.json: spec_version = 2, spec_hash = H2
/verify ───────── confere cada artefato contra a v2; grava spec_conformance.spec_version
/commit ───────── "43700 - Desconto por volume [spec_version=2]"
                  PR: título literal; descrição começa com
                  "Spec: memory/spec/43700-spec.md · spec_version=2 · spec_hash=<12>"
                  state.pull_request.app-back = {url, …, spec_version: 2, spec_hash: H2}
                  knowledge-graph: nó PR com spec_id / spec_version / spec_hash
```

### Por que a v1 só é selada no /plan

O `/fetch-ticket` cria a spec do template com Objetivo, Escopo e Critérios de Aceite
**vazios**, e uma pessoa os preenche antes do `/plan`. Se a v1 fosse congelada no
fetch-ticket, o preenchimento normal viraria "v2" sem nenhuma SPEC_CHANGE. Por isso o
fetch-ticket grava o bloco `spec` em `status: "draft"` (com o hash da criação em
`initial_hash`) e o `/plan`, que é quem lê o contrato para planejar, sela a versão:
`status: "active"`, `hash` = o que o Plan leu, e a entrada `initial` do changelog.

### Mudança de contrato sem SPEC_CHANGE (rebaseline)

Três situações mudam o hash contratual num ponto de baseline sem uma SPEC_CHANGE
aprovada:

- o `/commit` acrescenta nota de correção datada sob um AC (é autorizado a escrever na
  spec) e depois vem o retry de Recusa QA;
- uma pessoa revisa a spec entre ciclos e um ciclo novo começa;
- um humano devolve uma task em `spec-drift` para o `/plan` (replanejar sobre a spec nova).

Nesses casos a versão **não** incrementa, porque só SPEC_CHANGE aprovada incrementa. O
hash novo é registrado em `changelog.rebaselines[]` com a mesma versão e um
`diff_summary`, e `state.spec.hash` é atualizado. Assim a versão continua semântica e o
hash continua exato, sem esconder a diferença.

### Aprovação manual de drift

`spec_change_approved: true` + `spec_change_hash` gravados por um humano no state.json
(o caminho da Task 61) também valem como SPEC_CHANGE aprovada. Antes de despachar o
próximo nó, o portão de drift incrementa a versão se o contrato mudou, com
`approval_ref: "state.json#spec_change_hash=<12>"`. A operação é idempotente: o tick
seguinte não incrementa de novo.

## HASH_SCOPE

Definido em `.claude/spec-hash-config.json` e calculado **só** por
`scripts/lib/spec-hash.js`. `spec-authority`, `spec-change`, `spec-version`,
`acceptance-evidence`, `review-result` e `ac-registry` chamam essa mesma função.

Escopo atual: **`contract_sections_v1`**, uma allowlist de seções casadas pelo
cabeçalho normalizado (sem acento, minúsculo, sem `*_\``), em qualquer nível:

| Seção (id) | Cabeçalhos |
|---|---|
| `acceptance_criteria` | Critérios de Aceite |
| `objective` | Objetivo |
| `scope` | Escopo, Fora de escopo |
| `business_rules` | Regras de Negócio |
| `expected_behavior` | Comportamento Esperado |
| `solution` | Solução (specs no formato legado) |
| `constraints` | Restrições, Versão Alvo / Restrições de Deploy |

**Nunca entram no hash:** frontmatter (ticket, data, autor, `draft`,
`spec_template_version`), comentários HTML, linhas em branco, espaço repetido ou nas
bordas da linha, a própria linha do cabeçalho (renomear "Critérios de Aceite" para
"Critérios de aceite" não muda nada) e as seções Contexto, Problema, Referências, Anexos,
Dependências, Arquivos Afetados, Módulo Afetado, Responsável, Observações, **Casos-limite
/ Pontos a esclarecer** (também como subseção dentro de uma seção incluída), Decisões de
Implementação, Contexto Histórico e Histórico de Mudanças.

**Por quê:** só o que define *o que é entregue* (critérios verificáveis, objetivo,
escopo, regras, restrições) é contrato. Contexto e referências explicam o *porquê*.
Decisões e Histórico de Mudanças são trilha de auditoria acrescentada por ferramenta.

**Forma canônica** (o texto que é hasheado; para depurar, rode
`node "$PRISMA_ROOT/scripts/lib/spec-hash.js" <spec> --canonical`):

```
scope:contract_sections_v1
[acceptance_criteria]
- AC-01: …
[objective]
…
```

As seções aparecem **na ordem do config**, de modo que reordená-las na spec não muda o
contrato. Uma seção ausente aparece vazia. O id do escopo entra no texto, então hashes de
escopos diferentes nunca colidem.

**Mudar o escopo:** nunca edite um escopo já usado. Crie um id novo em `scopes` e aponte
`current` para ele. Runs gravados com o escopo antigo continuam sendo recalculados com o
escopo deles (`state.spec.hash_scope`).

## Formatos

### `state.json` → bloco `spec`

```json
"spec": {
  "id": "43700",
  "path": "memory/spec/43700-spec.md",
  "version": 2,
  "hash": "<sha256 contratual>",
  "hash_scope": "contract_sections_v1",
  "status": "active",
  "changelog_path": "memory/spec/43700-spec-changelog.json",
  "created_at": "…", "created_by": "fetch_ticket", "initial_hash": "…",
  "sealed_at": "…", "sealed_by": "plan",
  "updated_at": "…", "updated_by": "spec-change-approval",
  "last_change": { "spec_change_id": "SC-001", "approval_ref": "spec-change-audit.json#entry-2", "from_version": 1, "at": "…" }
}
```

Campos de raiz relacionados: `spec_hash` (baseline do drift, gravado pelo /plan; em run
versionado usa o mesmo algoritmo contratual), `spec_hash_scope` (`contract_sections_v1`
ou `legacy_normative`) e `spec_hash_version` (a versão que `spec_hash` representa).
Schema: `.graph/schemas/state.schema.json`.

### `memory/spec/<ticket>-spec-changelog.json`

O changelog é por spec, não por run: a spec sobrevive a vários ciclos. É append-only:
nenhuma entrada é reescrita, uma versão repetida ou fora de sequência é recusada, e um
JSON ilegível nunca é sobrescrito (o bump é recusado e vira evento `spec_version_error`).
Schema: `.graph/schemas/spec-changelog.schema.json`.

```json
{
  "schema_version": 1,
  "spec_id": "43700",
  "spec_path": "memory/spec/43700-spec.md",
  "hash_scope": "contract_sections_v1",
  "versions": [
    { "version": 1, "hash": "abc…", "created_at": "…", "created_by": "plan", "run_id": "43700-desconto",
      "reason": "initial", "approval_ref": null, "spec_change_id": null, "diff_summary": null,
      "fingerprint": { "acs": { "AC-01": "<12>", "AC-02": "<12>" }, "sections": { "acceptance_criteria": "<12>" } } },
    { "version": 2, "hash": "def…", "created_at": "…", "created_by": "spec-change-approval", "run_id": "43700-desconto",
      "reason": "SPEC_CHANGE SC-001: desconto progressivo acima de 50 volumes",
      "approval_ref": "spec-change-audit.json#entry-2", "spec_change_id": "SC-001", "approved_by": "po.fulano",
      "diff_summary": "AC-04 adicionado", "fingerprint": { … } }
  ],
  "rebaselines": [
    { "version": 2, "hash": "fed…", "at": "…", "by": "qa_retry", "run_id": "43700-desconto",
      "reason": "retry de Recusa QA: spec pós-/commit (notas de correção) vira o baseline — versão mantida",
      "diff_summary": "AC-02 reformulado", "fingerprint": { … } }
  ]
}
```

- `approval_ref` aponta para onde estão a aprovação e o diff completo: a entrada
  `approved` de `memory/runs/<run_id>/spec-change-audit.json` (1-based) ou
  `state.json#spec_change_hash=<12>` (aprovação manual de drift).
- `diff_summary` é um resumo legível do que mudou no HASH_SCOPE ("AC-04 adicionado;
  AC-02 removido; AC-01 reformulado; Escopo alterada"), e não um diff técnico. Ele sai do
  `fingerprint` (hash curto de cada AC e de cada seção), então o changelog não precisa
  copiar a spec.

### Artefatos derivados

| Artefato | `spec_version` / `spec_hash` em | Gravado por |
|---|---|---|
| Plan | `state.spec_hash` + `spec_hash_version`; linha `Spec: … · spec_version=N · spec_hash=<12>` no topo do `plan.md` | `spec-authority.js baseline` / agente do /plan |
| Review | `state.review_results.spec_version` / `.spec_hash`; `review-result.md` | `review-result.js record` |
| Test | `acceptance-evidence.json` → `spec_version`, `spec_hash`, `spec_hash_scope` | `acceptance-evidence.js finalize` |
| Verify | `state.spec_conformance.spec_version` / `.spec_hash`; `acceptance-evidence.json → verification.spec_version`; `spec-conformance.md` | `spec-authority.js verify --write` |
| Commit/PR | mensagem `… [spec_version=N]`; 1ª linha da descrição do PR; `state.pull_request.<repo>.spec_version/spec_hash` | agente do /commit (`spec-version.js commit-message` / `pr-line`) |
| Knowledge graph | nó `pr`: `spec_id`, `spec_version`, `spec_hash`; nó `spec`: `spec_version`, `spec_hash` | `knowledge-graph.js record` |

`spec_version` só é gravada quando o hash usado é o da versão vigente. Se não for
(SPEC_CHANGE no meio do run), o artefato grava `spec_version: null` e o nó alerta
(`ALERTA SPEC_CHANGE mid-run` no stderr e o evento `spec_change_mid_run`). Nunca inventa
uma versão.

**Alerta de SPEC_CHANGE mid-run (Verify).** `spec-version.checkArtifacts` compara o que
cada artefato registrou com a spec atual:

- artefato de outra versão ou de outro hash → `[WARN] SPEC_CHANGE_MID_RUN` (chega ao
  `spec-conformance.md` e à descrição do PR);
- mesmo hash com versão diferente (state inconsistente) → `[FAIL] SPEC_VERSION_MISMATCH`;
- matriz de evidência de outra versão → `[FAIL] EVIDENCE_SPEC_VERSION_MISMATCH` (ou
  `EVIDENCE_SPEC_STALE`, se o hash também mudou);
- `plan.md` sem a linha de versão → `[WARN] PLAN_SPEC_VERSION_MISSING`;
- artefato já em `stale_artifacts` → não repete o alerta (`STALE_ARTIFACTS` já reprova).

A mudança de contrato não aprovada continua sendo barrada antes, pelo portão de drift da
Task 65 (`status: "spec-drift"`).

## Quem escreve cada campo, e quando

| Campo | Quem | Quando |
|---|---|---|
| `state.spec` (criação, `draft`) | `/fetch-ticket` → `spec-version.js init` | logo depois de gravar o state.json, com a spec já criada |
| `state.spec` (selagem, `active`) + changelog v1 | `/plan` → `spec-authority.js baseline` (também o baseline tardio do watcher) | depois de gravar o state.json do Plan |
| `state.spec.version`+1, `last_change` + changelog vN | `spec-change.js approveSpecChange` (watcher, ao ler "aprovado" no Redmine, ou CLI `approve`) / portão de drift na aprovação manual | aprovação humana de SPEC_CHANGE **que altera o HASH_SCOPE** |
| `state.spec.hash` + `changelog.rebaselines[]` | `spec-authority.applyBaseline` (plan, watcher, qa_retry) | contrato mudou sem SPEC_CHANGE aprovada, num ponto de baseline |
| `spec_hash`, `spec_hash_scope`, `spec_hash_version` | `spec-authority.js baseline` / aprovação de SPEC_CHANGE | /plan, retry de Recusa QA, aprovação |
| `review_results.spec_version` | `review-result.js record` | /review |
| `acceptance-evidence.json.spec_version` | `acceptance-evidence.js finalize` | /test |
| `spec_conformance.spec_version`, `verification.spec_version` | `spec-authority.js verify --write` | /verify |
| `pull_request.<repo>.spec_version/spec_hash`, mensagem de commit | agente do `/commit` | push + PR |

Nenhum agente escreve o bloco `spec` ou o changelog à mão.

## Runs legados (unversioned)

O bloco `spec` ausente marca um run legado. Não há reescrita retroativa: nenhuma spec,
state ou matriz existente é migrada. Todo leitor degrada sem falhar:

- `spec_hash` continua no algoritmo antigo (`legacy_normative`: o arquivo inteiro menos
  as seções de APPEND), então runs em andamento não entram em drift por causa da troca
  de algoritmo;
- `spec-version.readSpecBlock(state)` devolve `null` para bloco ausente ou malformado e
  nunca lança;
- os artefatos gravam `spec_version: null`, e o Verify não aplica nenhuma checagem de
  versão;
- a mensagem de commit sai intacta, o PR não leva a linha de versão e o nó PR do
  knowledge graph fica sem `spec_version`;
- o dashboard (`show`) responde `status: "UNVERSIONED"`.

## Dashboard (dados — a UI é das Tasks 67–72)

`node "$PRISMA_ROOT/scripts/lib/spec-version.js" show memory/runs/<task-id> --json` (ou
`specVersion.describe(state, {root})` no servidor) devolve:

```json
{
  "versioned": true, "spec_id": "43700", "version": 2, "hash": "…", "hash_short": "def123456789",
  "status": "ACTIVE",
  "label": "SPEC v2 | hash: def123456789… | Status: ACTIVE",
  "history_label": "v1 → SPEC_CHANGE SC-001 → v2",
  "history": [ { "version": 1, "reason": "initial", … }, { "version": 2, "spec_change_id": "SC-001", "approval_ref": "…", "diff_summary": "AC-04 adicionado", "rebaselines": 0 } ],
  "last_change": { … }, "changelog_path": "…", "changelog_error": null
}
```

`status` vale `DRAFT` (antes do /plan), `ACTIVE`, `PENDING_CHANGE` (SPEC_CHANGE
aguardando aprovação), `DRIFT` (spec-drift), `CHANGE_REJECTED` ou `UNVERSIONED`.

## Comandos

```bash
node "$PRISMA_ROOT/scripts/lib/spec-hash.js" memory/spec/43700-spec.md [--canonical | --fingerprint]   # hash contratual
node "$PRISMA_ROOT/scripts/lib/spec-authority.js" hash memory/spec/43700-spec.md --run=memory/runs/<task-id>  # hash no algoritmo do run
node "$PRISMA_ROOT/scripts/lib/spec-version.js" init memory/runs/<task-id>                 # /fetch-ticket
node "$PRISMA_ROOT/scripts/lib/spec-version.js" show memory/runs/<task-id> [--json]        # versão, status, histórico
node "$PRISMA_ROOT/scripts/lib/spec-version.js" changelog memory/runs/<task-id>            # changelog da spec
node "$PRISMA_ROOT/scripts/lib/spec-version.js" commit-message memory/runs/<task-id> "43700 - Título"
node "$PRISMA_ROOT/scripts/lib/spec-version.js" pr-line memory/runs/<task-id>
node --test scripts/lib/spec-hash.test.js scripts/lib/spec-version.test.js
```
