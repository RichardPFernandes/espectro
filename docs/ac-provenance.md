> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
+> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
+> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
+> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
+> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.
+
# AC Provenance

Implementação: `scripts/lib/ac-provenance.js`. Levantamento que originou este desenho,
incluindo os conflitos de evidência EC-1..EC-4 que fizeram o desenho final divergir da
hipótese inicial: [`docs/ac-provenance-sources.md`](ac-provenance-sources.md).

## Objetivo

Cada Critério de Aceite carrega a sua **história demonstrável**: de onde veio e o que
aconteceu com ele depois, como referências estruturadas (ticket, journal, change_id,
spec_hash...). A cadeia completa fica rastreável:

```
Source  →  AC  →  Spec Version  →  Evidence  →  PR
```

Princípio: **PROVENANCE = EVIDENCE**, nunca inferência. Quando a origem não pode ser
demonstrada por uma referência persistida, o resultado correto é `UNKNOWN`.

O texto do AC continua só na spec (`memory/spec/<ticket>-spec.md`). A provenance guarda
só referências.

## Identidade

```
AC = (ticket_id, ac_id)
```

`ac_id` **não** é global: todo ticket tem o seu `AC-01`. `(43666, AC-01)` e
`(43703, AC-01)` são ACs diferentes. Nenhum código usa só `ac_id` como identidade. O log é
por ticket, o `event_id` começa por `<ticket>:<ac>`, e a API exige o ticket (ou devolve
409 quando ele é ambíguo).

## Fontes

Resultado do levantamento de 2026-10-01 (detalhes, arquivos e linhas em
`docs/ac-provenance-sources.md`). Fatos que definiram o desenho:

- **O `/fetch-ticket` não cria AC.** Ele cria a spec do template e deixa
  `## Critérios de Aceite` vazio de propósito, porque quem transforma critério em `AC-NN`
  é uma pessoa. Por isso não há captura de provenance no `/fetch-ticket`.
- ACs nascem ou mudam em:
  1. **`spec-generator`** (`runSpecDraftGate`): a subseção "Critérios de Aceite" da
     descrição vira `AC-NN` literalmente. A IA (`fillSpecDraftGaps`) pode sugerir ACs
     dentro do mesmo rascunho.
  2. **`spec-repairer`** (`handleSpecRepair`, auto-repair): Claude gera os ACs que
     faltam e um humano aprova com "aprovado" no Redmine. Em 2026-10-01 era a origem mais
     comum (8 de 12 gate files reais).
  3. **Edição manual da spec** pelo desenvolvedor, que é o caminho oficial do template.
  4. **SPEC_CHANGE aprovada** (`spec-change.js approveSpecChange`): adiciona, substitui
     ou remove AC.
  5. **`ac-ids.js number --write`**: só atribui ID a texto legado e não é origem.
- O que **não** materializa AC:
  - `withSpecReplies`: o comentário que completa a spec só é validado, nunca gravado
    como `AC-NN` (EC-2).
  - `human-input.md`/`human_input_interpretations`: não têm vínculo estruturado com AC
    (EC-3).
  - `pretask-question`, `spec-enricher`, `TECHNICAL_DECISION`/`SPEC_CLARIFICATION`.
- **Sem produtor automático hoje:** `REDMINE_CUSTOM_FIELD` (o único campo customizado
  usado é `Branch Liberação`) e `ATTACHMENT` (anexos são baixados e resumidos, nada
  extrai AC deles).
- **Dados reais:** nenhuma das 29 specs tinha IDs `AC-NN`. O Registry tinha 25 entradas
  `legacy` com o texto em `criteria[]` e 2 no formato v1.

## Source Types

| type | Significado | Referência (campos) | Produtor automático hoje |
|---|---|---|---|
| `REDMINE_DESCRIPTION` | critério veio da subseção "Critérios de Aceite" da descrição do ticket | `ticket_id`, `via: "spec-generator"`, `spec_path`, `generated_at` | sim: spec-generator |
| `REDMINE_COMMENT` | critério veio de um comentário (journal) do ticket | `ticket_id`, `journal_id` | não (só `declare`, EC-2) |
| `REDMINE_CUSTOM_FIELD` | critério veio de campo customizado | `field_id`, `field_name` | não (só `declare`) |
| `ATTACHMENT` | critério veio de um anexo; o conteúdo nunca é gravado | `attachment_id`, `filename`, `content_type` | não (só `declare`) |
| `HUMAN_CLARIFICATION` | mensagem humana ligada estruturalmente ao AC | `message_hash`, `at`, `node`, `task_id`, `change_id` | sim: SPEC_CHANGE com `human_input_refs` válido |
| `HUMAN_AUTHORED` | uma pessoa escreveu o critério | o que a declaração trouxer + `declared: true` | não (só `declare`) |
| `AGENT_DRAFT_APPROVED` | agente escreveu, humano aprovou | `via`, `authorship`, `authority`, `draft_comment_id`, `approval_journal_id`, `approved_by`, `approved_at`, `approval`, `merged_sections`, `spec_path` | sim: spec-repairer e spec-generator (IA) |
| `SPEC_CHANGE` | SPEC_CHANGE aprovada tocou o AC | `change_id`, `approval_ref`, `proposal_comment_id`, `approval_journal_id`, `spec_hash_before`, `spec_hash_after`, `previous_version`, `new_version`, `action`, `replaces`/`replaced_by`, `task_id` | sim: approveSpecChange |
| `UNKNOWN` | origem não demonstrável com os dados disponíveis | `reason`, `spec_hash`, `spec_version`, `sealed_at`, `spec_path`, ou a string `"legacy-numbering"` | sim: baseline do /plan, ac-ids number |

Um tipo existir no enum **não** significa que existe produtor automático para ele.

## Source Roles

| role | Significa |
|---|---|
| `ORIGIN` | de onde o AC veio (ou `UNKNOWN`, quando não se sabe) |
| `CLARIFICATION` | esclarecimento posterior ligado ao AC |
| `MODIFICATION` | o AC foi criado, substituído, removido ou afetado por SPEC_CHANGE aprovada (`reference.action`: `add`, `replace`, `remove`, `affected`) |
| `APPROVAL` | reservado: aprovação como evento separado. Hoje a aprovação vai dentro da referência do evento que ela aprova, para não duplicar falsamente o evento |

Não existe precedência global entre fontes. A cadeia inteira é preservada e
`CLARIFICATION`/`MODIFICATION` nunca apagam nem sobrescrevem `ORIGIN`. Um
`effective_source`, se algum consumidor vier a precisar, deve ser **derivado**
deterministicamente de `sources[]`, e não está implementado.

Um AC criado por SPEC_CHANGE tem como primeiro evento `SPEC_CHANGE/MODIFICATION` com
`action: "add"`: a SPEC_CHANGE é a origem dele, e o baseline não acrescenta `UNKNOWN`
porque o AC já tem evento.

## Authorship vs Authority

```
AUTHORSHIP ≠ AUTHORITY
```

`AGENT_DRAFT_APPROVED` significa: o texto foi **gerado por um agente** a partir das fontes
disponíveis e depois **aprovado por uma pessoa**. A referência explicita
`authorship: "AGENT"` e `authority: "HUMAN_APPROVED"`. A aprovação humana não transforma o
AC em `HUMAN_AUTHORED`. `HUMAN_AUTHORED` exige declaração explícita, porque a ausência de
outra fonte não é autoria humana:

```
ABSENCE OF ANOTHER SOURCE ≠ HUMAN AUTHORSHIP
```

## Pontos de captura

| Onde | Quando | Evento |
|---|---|---|
| `readmine-watcher.js` `runSpecDraftGate` | rascunho gerado com critérios da descrição | `REDMINE_DESCRIPTION/ORIGIN` para os IDs que saíram do gerador |
| `runSpecDraftGate` (rascunho liberado) | IA sugeriu critérios no rascunho e o humano liberou (resposta "aprovado" no Redmine, ou `draft: false` à mão) | `AGENT_DRAFT_APPROVED/ORIGIN` para os IDs sugeridos que continuam na spec. Com Redmine: `approved_by`, `approval_journal_id`. À mão: `approval: "manual-draft-release"`, sem autor |
| `handleSpecRepair` | draft do auto-repair aprovado e mesclado | `AGENT_DRAFT_APPROVED/ORIGIN` para os IDs que o merge acrescentou (`draft_comment_id` ≠ `approval_journal_id`) |
| `withSpecReplies` | comentário completou a spec | **nenhum** evento de AC; `completed_by_journal_ids` no `<ticket>-spec-gate.json` (evidência do portão) |
| `spec-change.js approveSpecChange` | SPEC_CHANGE aprovada | `HUMAN_CLARIFICATION/CLARIFICATION` (só com `human_input_refs` válido) e depois `SPEC_CHANGE/MODIFICATION` para cada AC tocado |
| `spec-change.js rejectSpecChange` | SPEC_CHANGE rejeitada | nada |
| `spec-authority.js baseline` (/plan) | spec selada | `UNKNOWN/ORIGIN` (`reason: "no-demonstrable-provenance"`) para todo AC **sem nenhum** evento |
| `ac-ids.js number --write` | texto legado numerado | `UNKNOWN/ORIGIN`, `reference: "legacy-numbering"` |
| `ac-provenance.js declare` | pessoa declara a origem | qualquer type/role, com `declared: true` |
| `human-input` | mensagem do dashboard | **nenhum** evento direto |

Escopo da evidência (INV-AC-PROVENANCE-03):

```
TICKET EVIDENCE ≠ AC EVIDENCE
SPEC EVIDENCE ≠ AC EVIDENCE
TEXTUAL MENTION ≠ STRUCTURED PROVENANCE LINK
```

Limitação conhecida: o evento `REDMINE_DESCRIPTION` registra o que o gerador produziu.
Se o revisor reescreve aquele AC antes de liberar o rascunho, a edição não é capturada.

Dry-run (`DRY_RUN=true` ou run com `dry_run: true`) nunca grava provenance.

### Declaração explícita (CLI)

```bash
# Autoria humana (o único caminho de HUMAN_AUTHORED)
node "$PRISMA_ROOT/scripts/lib/ac-provenance.js" declare 43703 AC-02 --type=HUMAN_AUTHORED --role=ORIGIN \
  --ref='{"declared_by":"<quem escreveu>","spec_hash":"<hash da spec>"}'
# Origem num comentário/anexo específico
node "$PRISMA_ROOT/scripts/lib/ac-provenance.js" declare 43584 AC-01 --type=REDMINE_COMMENT --role=ORIGIN --ref='{"ticket_id":"43584","journal_id":123}'
node "$PRISMA_ROOT/scripts/lib/ac-provenance.js" declare 43584 AC-03 --type=ATTACHMENT --role=ORIGIN --ref='{"attachment_id":77,"filename":"print.png","content_type":"image/png"}'
# Consulta
node "$PRISMA_ROOT/scripts/lib/ac-provenance.js" show 43666 AC-01
```

Uma referência com campo de conteúdo ou credencial (`text`, `notes`, `content`,
`description`, `criteria`, `token`, `api_key`, `authorization`...) ou com string acima de
200 caracteres é recusada, e nada é gravado.

## Legacy Strategy

- **ACs novos:** provenance estruturada nos pontos de captura acima.
- **ACs legados:** provenance só quando demonstrável; senão `UNKNOWN` (no baseline do
  próximo ciclo ou na numeração) ou nada (endpoint responde `legacy: true, sources: []`).
- **Fora de escopo, de propósito:** reconstrução em massa, LLM adivinhando origem,
  correlação de texto com comentário antigo, descoberta de `approval_journal_id`
  histórico por horário. Registro histórico sem esse journal fica com
  `approval_journal_id: null`.

## UNKNOWN Semantics

**INV-AC-PROVENANCE-01: Absence of provenance is not evidence of origin.**

Se a origem de um AC não pode ser demonstrada por uma referência persistida,
`source.type` é `UNKNOWN`. O sistema nunca infere `REDMINE_DESCRIPTION`,
`REDMINE_COMMENT`, `HUMAN_AUTHORED`, `AGENT_DRAFT_APPROVED`, `ATTACHMENT` ou `SPEC_CHANGE`
a partir do texto do AC.

```
UNKNOWN ≠ FAIL
UNKNOWN ≠ inferred truth
UNKNOWN = provenance não demonstrável com os dados disponíveis
```

`UNKNOWN` não reprova nenhum nó.

## Registry Storage

```
PROVENANCE LOG = SOURCE OF TRUTH     memory/spec/<ticket>-ac-provenance.json
AC REGISTRY    = DERIVED PROJECTION  .graph/ac-registry.json → tasks["<ticket>"].ac_sources
```

**INV-AC-PROVENANCE-02: Derived storage is not provenance authority.** O Registry é
índice derivado (`ac-registry.js`: "não histórico"; `rebuild-ac-registry.js` reconstrói do
zero), então guarda `ac_sources` apenas como projeção. `updateRegistry` e o rebuild
recalculam `ac_sources` a partir do log. Apagar, corromper ou reconstruir o Registry não
perde provenance (EC-1).

Log (no checkout principal, mesmo quando o evento nasce num worktree; resolvido via
`git rev-parse --git-common-dir`, com `AC_PROVENANCE_ROOT` como override de teste):

(Formato ilustrativo: é como ficaria o `SC-001` do 43666 se fosse aprovado hoje. O
`approval_journal_id` e o `recorded_at` abaixo são placeholders, e o log real do 43666 não
existe, ver "Exemplo real".)

```json
{
  "version": 1,
  "ticket_id": "43666",
  "events": [
    {
      "event_id": "43666:AC-01:SPEC_CHANGE:MODIFICATION:SC-001",
      "ac_id": "AC-01",
      "type": "SPEC_CHANGE",
      "role": "MODIFICATION",
      "recorded_at": "2026-10-01T11:21:49.812Z",
      "reference": {
        "change_id": "SC-001",
        "approval_ref": "spec-change-audit.json#entry-1",
        "proposal_comment_id": 45411,
        "approval_journal_id": 45999,
        "spec_hash_before": "e4ca706a…",
        "spec_hash_after": "adad9d6c…",
        "previous_version": null,
        "new_version": null,
        "action": "add",
        "task_id": "43666-sincroniza-produtos-nfe"
      }
    }
  ]
}
```

`recorded_at` é o momento em que **o sistema registrou** o evento, e não o momento em que
o AC foi criado. Não existe `created_at`.

Projeção no Registry (só aparece quando há eventos; `criteria[]` legado continua
intocado, e `getRelatedACs`/`plan-scorer` ignoram a chave nova):

```json
"43666": { "ticket_id": "43666", "spec_hash": "…", "ac_ids": ["AC-01"],
           "ac_sources": { "AC-01": [ { "event_id": "…", "type": "SPEC_CHANGE", "role": "MODIFICATION", "recorded_at": "…", "reference": { … } } ] } }
```

O Registry **continua** guardando texto em `criteria[]` das entradas legadas (specs sem
`AC-NN`), por compatibilidade. A regra é que provenance nova não duplica texto de AC, e
não que o Registry nunca contenha texto.

## API

```
GET /api/provenance/:ticket/:ac_id          preferencial
GET /api/provenance/:ac_id?ticket=<ticket>  equivalente
GET /api/provenance/:ac_id                  sem ticket: só resolve se UM ticket tiver o AC
```

| Caso | Resposta |
|---|---|
| AC existe (spec principal, spec do worktree do ticket, `ac_ids` do Registry ou log) | 200 |
| AC existe, sem nenhum evento | 200, `legacy: true`, `sources: []` |
| não existe | 404 com mensagem; ticket legado sem IDs explica isso |
| sem ticket e o AC existe em mais de um ticket | 409, `candidates: ["43666", "43703", …]` (nunca escolhe um) |
| ticket/AC malformado | 400 |
| log ilegível | 500 (o log não é tocado) |

```json
{
  "ticket_id": "43666",
  "ac_id": "AC-01",
  "legacy": false,
  "sources": [ { "event_id": "…", "type": "SPEC_CHANGE", "role": "MODIFICATION", "recorded_at": "…", "reference": { "change_id": "SC-001", "…": "…" } } ],
  "task_id": "43666-sincroniza-produtos-nfe",
  "spec_version": null,
  "spec_hash": "adad9d6c…",
  "evidence_ref": "memory/runs/43666-sincroniza-produtos-nfe/acceptance-evidence.json#AC-01",
  "pr_ref": null
}
```

`spec_version`/`spec_hash`/`evidence_ref`/`pr_ref` vêm do run mais recente do ticket
(`null` quando não há). Não há `effective_source`. A resposta passa pelo `redactDeep` do
dashboard, e as referências por construção só contêm identificadores. Nenhum
`BITBUCKET_API_TOKEN`, `REDMINE_API_KEY`, header de autenticação, texto de comentário ou
conteúdo de anexo sai daqui.

### Consumo no dashboard (Tasks 67 e 72)

Esta task entrega só os dados, sem UI.

- **Task 67 (RunDetail, Spec Compliance):** para cada AC do run, chame
  `GET /api/provenance/<ticketId>/<AC>` e mostre um badge a partir do **primeiro**
  `ORIGIN` (ex.: `REDMINE_DESCRIPTION` → "Origem: descrição do ticket";
  `AGENT_DRAFT_APPROVED` → "Origem: IA · aprovado por humano"; `UNKNOWN` → "Origem não
  demonstrável"). O tooltip lista o resto da cadeia em ordem. `legacy: true` mostra "sem
  provenance registrada".
- **Task 72 (SpecDetail):** mesmo endpoint. O badge destaca o **último**
  `MODIFICATION` (ex.: "SPEC_CHANGE SC-002 · aprovado (journal #…)") e o tooltip, a
  cadeia completa.
- Sempre com o ticket na URL. O 409 só aparece se a UI chamar sem ticket.

## Append-only / Idempotency

- `sources[]` (eventos do log) é **append-only**: nenhum evento é alterado ou removido,
  nem em clarification, SPEC_CHANGE, nova aprovação ou nova versão da spec.
- `event_id = <ticket>:<ac>:<type>:<role>:<chave natural>`. Append de `event_id` que já
  existe é **no-op**. Chaves naturais:

| Evento | Chave |
|---|---|
| `SPEC_CHANGE` | `change_id` (SC-NNN) |
| `HUMAN_CLARIFICATION` | `message_hash` |
| `REDMINE_COMMENT` declarado | `journal_id` |
| `AGENT_DRAFT_APPROVED` (repairer) | `draft-<draft_comment_id>` |
| `AGENT_DRAFT_APPROVED` (rascunho do gerador) | `spec-generator-<generated_at>` |
| `REDMINE_DESCRIPTION` | `spec-generator` |
| `UNKNOWN` (baseline) | `baseline-<spec_hash[:16]>` |
| `UNKNOWN` (numeração) | `legacy-numbering` |
| declarado sem identificador | `--key`, senão `declared-<sha256(reference)[:16]>` |

- Nenhum UUID aleatório. Escrita com lock (`<log>.lock`, O_EXCL) + tmp/rename, tudo ou
  nada: um evento inválido no lote faz o append inteiro ser recusado. Log com JSON
  inválido nunca é sobrescrito.

## SPEC_CHANGE

- A proposta (`spec-change.js record`) aceita `human_input_refs[]` opcional
  (`{message_hash, at?}`). Na aprovação cada ref é conferida contra
  `state.human_input_interpretations[]`; só as válidas viram `HUMAN_CLARIFICATION`.
  Inválidas voltam em `approveSpecChange().provenance.human_input_refs_invalid`.
- O audit `approved` grava `proposal_comment_id` (journal que o watcher postou com a
  proposta) e `approval_journal_id` (journal da resposta "aprovado", que o watcher agora
  repassa) **separados** (EC-4). O CLI aceita `approve --journal=<id>`.
- ACs tocados: os criados (`add`/`replace`, na ordem dos IDs que `applyToSpec` atribuiu),
  os substituídos/removidos e os de `ac_affected`.
- Rejeição não grava provenance.
- `scripts/spec-change-audit.js` não existe e não foi criado: a auditoria é
  `scripts/lib/spec-change.js` (`readAudit`/`appendAudit`).

## Exemplo real: ticket 43666

Situação real do 43666 em 2026-10-01, sem backfill:

- `human-input.processed.md` do run: o solicitante pediu, pelo dashboard, a validação dos
  produtos do JSON contra o XML.
- `/implement` registrou `SC-001` (SPEC_CHANGE, `ac_changes: add`), com o human input
  citado **só em texto** no `rationale`.
- O watcher publicou a proposta no journal **45411** (`comment_id`). A resposta
  "aprovado" veio depois, em outro journal, que não foi persistido (antes do EC-4).
- A aprovação criou `AC-01` (`ac_added`), com `spec_hash` `e4ca706a…` → `adad9d6c…`. Sem
  `spec_version`, porque o run é anterior ao versionamento.
- O `/test` gerou `acceptance-evidence.json`. Não há PR (run `escalated`).

Hoje, `GET /api/provenance/43666/AC-01` responde (dados reais):

```json
{ "ticket_id": "43666", "ac_id": "AC-01", "legacy": true, "sources": [],
  "task_id": "43666-sincroniza-produtos-nfe", "spec_version": null,
  "spec_hash": "adad9d6c766f95744fb2077f017e15082c052e095f18d9d2de1ed7035b4c8eb9",
  "evidence_ref": "memory/runs/43666-sincroniza-produtos-nfe/acceptance-evidence.json#AC-01",
  "pr_ref": null }
```

A aprovação foi anterior a esta implementação e não há backfill, então `sources: []`. Se
o mesmo fluxo acontecer agora, a cadeia fica assim:

```
Source:   SPEC_CHANGE/MODIFICATION  SC-001 · approval_ref spec-change-audit.json#entry-1
                                    · proposal_comment_id 45411 · approval_journal_id <id da resposta>
          (+ HUMAN_CLARIFICATION/CLARIFICATION antes, só se a proposta trouxer human_input_refs)
AC:       (43666, AC-01)
Version:  spec_hash adad9d6c… (spec_version quando o run é versionado)
Evidence: memory/runs/43666-…/acceptance-evidence.json#AC-01
PR:       state.pull_request do run (quando houver)
```

Pela regra TEXTUAL MENTION ≠ STRUCTURED LINK, o human input citado no `rationale`
continua **sem** `HUMAN_CLARIFICATION` retroativo.

## Future Knowledge Graph Integration

Fora desta task (Task 71). O KG atual (`scripts/lib/knowledge-graph.js`) só tem nós
`ticket`/`spec`/`pr`/`file`, sem nó de AC nem de fonte. Contrato para o Task 71
implementar a partir do log, sem copiar conteúdo externo:

```
nó   AC-<ticket>-<ac>                       type "ac"     (ticket_id, ac_id)
nó   SRC-<type>-<chave natural>             type "source" (source_type, ticket_id, + ids da reference:
                                            journal_id | change_id | message_hash | attachment_id | field_id)
aresta  TASK-<ticket> --has_ac-->     AC-<ticket>-<ac>
aresta  AC-<ticket>-<ac> --sourced_from{role, event_id, recorded_at}--> SRC-…
```

A aresta aponta para a referência (journal_id, change_id...), nunca para uma cópia do
texto. Fonte dos dados: `memory/spec/<ticket>-ac-provenance.json`.

## Invariants

- **INV-AC-PROVENANCE-01:** absence of provenance is not evidence of origin. Origem não
  demonstrável → `UNKNOWN`.
- **INV-AC-PROVENANCE-02:** derived storage is not provenance authority. Perder ou
  reconstruir o Registry não perde provenance.
- **INV-AC-PROVENANCE-03:** evidence scope must be preserved. Evidência de ticket, spec,
  gate ou human input não vira provenance de AC sem vínculo estruturado.
- Identidade = `(ticket_id, ac_id)`.
- `sources[]` é append-only e idempotente por `event_id` natural.
- Nenhum texto de AC, comentário ou anexo, e nenhuma credencial, no log, na projeção ou
  na API.
- `recorded_at` ≠ data de criação do AC.
- `AUTHORSHIP ≠ AUTHORITY`. `AGENT_DRAFT_APPROVED` nunca vira `HUMAN_AUTHORED`.
