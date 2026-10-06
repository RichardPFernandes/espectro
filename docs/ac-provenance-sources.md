> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
+> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
+> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
+> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
+> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.
+
# Provenance de ACs — levantamento das fontes reais (AC-01)

Levantamento feito em 2026-10-01, **antes de qualquer código**, sobre o checkout
`app-back` (branch `removendo-memory`).

**Status:** aprovado com ajustes em 2026-10-01. EC-1..EC-4 (seção 5) foram aceitos como
decisões definitivas e implementados. O desenho final está em `docs/ac-provenance.md`.
Este arquivo é mantido como registro da descoberta: a seção 4 é a proposta **anterior**
aos conflitos (a precedência entre fontes, por exemplo, foi descartada em favor de
`sources[]` + `role`), e a seção 5 explica por que o desenho final difere da hipótese
original. Não apague os conflitos.

## 1. Fato que muda o desenho: o `/fetch-ticket` não cria AC

`.claude/commands/fetch-ticket.md` (passo 5) cria a spec do template e **proíbe** preencher
`## Critérios de Aceite`: "Mesmo que o ticket traga critérios explícitos, eles ficam no
`## Contexto` — quem os transforma em `AC-NN` é uma pessoa". O state.json sai com
`ac_ids: []`. Então "capturar provenance no fetch-ticket" não tem onde se apoiar: os ACs
nascem em outros pontos (tabela abaixo), quase todos no watcher.

## 2. Pontos reais onde um AC nasce ou muda

| # | Mecanismo (código) | O que acontece | Tipo proposto | Referência disponível hoje | Gap |
|---|---|---|---|---|---|
| 1 | `spec-generator.js` (`runSpecDraftGate` no watcher) | Subseção "Critérios de Aceite" da **descrição** do ticket vira `AC-NN` (texto literal, `numberCriteriaText`). Spec sai `draft: true`, humano libera. Ex.: 43685, 43703 | `REDMINE_DESCRIPTION` | ticket_id; `spec_draft_approved` no `<id>-spec-gate.json` | não marca quais ACs vieram da descrição vs. editados na revisão |
| 2 | `withSpecReplies` (watcher, portão de spec) | Spec incompleta é **completada por comentário** no Redmine (achado ao vivo no #43584, Recusa QA: Critérios vieram num comentário) | `REDMINE_COMMENT` | `completed_by` = string "Nome (comentário no Redmine, data)" | **journal_id não é persistido** — só nome+data; o objeto `j` tem `j.id` no momento |
| 3 | `spec-repairer.js` + `handleSpecRepair` (auto-repair) | Claude **gera** os ACs faltantes a partir de título+descrição; draft comentado no Redmine; resposta `aprovado` mescla. **8 dos 12 gate files reais** (43585, 43590, 43644, 43646, 43670, 43672, 43673, 43683) mesclaram `criterios_aceite` por aqui (43666 também passou, sem ACs) — é a origem mais comum de AC hoje | **novo: `AGENT_DRAFT_APPROVED`** | `spec_pending_approval.comment_id` (journal do draft), `spec_repair.approved_by/approved_at/merged_sections` | journal_id da resposta de aprovação não é guardado |
| 4 | Edição manual da spec (fluxo do template) | Dev escreve os `AC-NN` à mão em `memory/spec/<id>-spec.md` (caminho oficial do fetch-ticket) | **novo: `HUMAN_AUTHORED`** | `spec.sealed_at`/`spec_hash` do `/plan` (spec-version baseline); git do worktree | nenhum registro de autor/momento além do hash selado |
| 5 | `human-input.md` (dashboard "Responder ao agente") → `human-input-intent.js` | Mensagem do dev chega ao agente; pode pedir comportamento novo. Interpretação fica em `state.human_input_interpretations[]` (timestamp, intent, node). Ex.: `_archive/43666-.../human-input.processed.md` | `HUMAN_CLARIFICATION` | timestamp do bloco `## Human input — <ISO>`; entrada em `human_input_interpretations` | o human-input sozinho **não cria AC**: no caso real ele virou SPEC_CHANGE (linha 6) |
| 6 | `spec-change.js` `approveSpecChange` | SPEC_CHANGE aprovada adiciona/substitui/remove AC (`ac_added`, `ac_changes`). Ex. real 43666: `SC-001`, aprovado pelo journal **45411**, `ac_added: ["AC-01"]`, rationale cita o human input de 2026-09-30 | `SPEC_CHANGE` | `id` (SC-NNN), índice no audit (`approvalRef = spec-change-audit.json#entry-N`), `comment_id`, `spec_hash_before/after`, `spec-version.js bump` (previous/new version) | — (é a fonte mais bem referenciada) |
| 7 | `ac-ids.js number --write` | Numera spec **legada** sem IDs, sem mudar o texto | não é origem → `UNKNOWN` (`reference: "legacy-numbering"`) | — | origem real do texto perdida |
| 8 | Recusa QA (ticket volta, mesma spec, task nova) | QA comenta; o dev/portão incorpora como em 2/4/6 | sem tipo próprio; cai em 2, 4 ou 6 | — | — |

Fontes da lista pedida **sem produtor real hoje**:

- `REDMINE_CUSTOM_FIELD`: o único campo customizado usado no código é `Branch Liberação`
  (decide a branch base). Nenhum AC vem de campo customizado. Fica no enum (suportado,
  `field_name` + `field_id`), sem ponto de captura automático.
- `ATTACHMENT`: o `attachment-downloader.js` baixa e o fetch-ticket resume em
  `## Referências`, mas nada extrai AC de anexo automaticamente (o spec-repairer só lê
  título+descrição). Só um humano pode declarar "AC-03 veio do print X". Fica no enum
  (`attachment_id` + `filename` + `content_type`), captura só declarada.

Não são fonte de AC (avaliados e descartados): `<id>-pretask-question.md` (decide branch
com working tree sujo), `spec-enricher.js` (só acrescenta "Contexto Histórico"),
`TECHNICAL_DECISION`/`SPEC_CLARIFICATION` do `/implement` (por definição não mudam AC;
SPEC_CLARIFICATION pode virar referência de esclarecimento, não de criação).

## 3. Estado real dos dados (impacta AC-02 e AC-06)

- **Nenhuma** das 29 specs em `memory/spec/` tem IDs `AC-NN` hoje.
- `.graph/ac-registry.json`: 27 entradas — **25 `legacy: true` com `criteria[]` = texto
  dos critérios**, 2 no formato v1 (`specHash` + `criteria`), 0 com `ac_ids`. Ou seja, o
  Registry atual **já guarda texto de AC** (exceção de compatibilidade documentada em
  `ac-registry.js`), o que conflita com "nenhum texto de AC no Registry".
- Único `spec-change-audit.json` existente: worktree 43666 (`SC-001`, `spec_version: null`
  — anterior ao Task 73).
- `scripts/spec-change-audit.js` (citado como Task 65) **não existe**; a auditoria vive em
  `scripts/lib/spec-change.js` (`readAudit`/`appendAudit`, `approvalRef`
  `spec-change-audit.json#entry-N`).
- Knowledge Graph (`scripts/lib/knowledge-graph.js`): nós só `ticket`/`spec`/`pr`/`file`;
  sem nó AC nem nó de fonte externa. A decisão de spec-versioning diz que o dado está
  "pronto para a aresta PR→SpecVersion (Task 71)" → **Task 71 não está implementada**.
- `ac_id` **não é único globalmente**: todo ticket tem seu `AC-01`. O Registry é chaveado
  por ticket.

## 4. Proposta (para validar)

**Enum final:** `REDMINE_DESCRIPTION`, `REDMINE_COMMENT`, `REDMINE_CUSTOM_FIELD`,
`ATTACHMENT`, `HUMAN_CLARIFICATION`, `HUMAN_AUTHORED` *(novo)*, `AGENT_DRAFT_APPROVED`
*(novo)*, `SPEC_CHANGE`, `UNKNOWN`.

**Precedência ajustada:** `SPEC_CHANGE` > `HUMAN_CLARIFICATION` > `HUMAN_AUTHORED` >
`REDMINE_COMMENT` > `REDMINE_CUSTOM_FIELD` > `REDMINE_DESCRIPTION` >
`AGENT_DRAFT_APPROVED` > `ATTACHMENT` > `UNKNOWN` (gerado por agente fica abaixo do que veio
de pessoa/ticket; aprovação humana do draft vai como referência, não muda o tipo).

**Pontos de captura** (no lugar do fetch-ticket): `runSpecDraftGate`/`spec-generator`
(1), `withSpecReplies` (2, passando a guardar `journal_id`), `handleSpecRepair` (3),
`/plan` baseline (4 e fallback `UNKNOWN` para todo AC ainda sem fonte), `approveSpecChange`
(6, append). `fetch-ticket.md` só ganha a instrução de não registrar fonte (não cria AC).

**Registry:** `sources[]` por AC dentro da entrada do ticket
(`tasks["43666"].ac_sources["AC-01"] = [...]`), só referências. Entradas legadas com
`criteria[]` ficam como estão (mexer quebraria `getRelatedACs`/`plan-scorer`) e respondem
`legacy: true, sources: []` no endpoint.

**Endpoint:** `GET /api/provenance/:ticket/:ac_id` (ex.: `/api/provenance/43666/AC-01`),
mais `GET /api/provenance/:ac_id?ticket=43666`; sem `ticket` e com o ID em mais de um
ticket → 409 com a lista de tickets.

**KG:** Task 71 não implementada → não criar aresta agora; o handoff documenta o schema da
aresta `AC → SOURCE` para o Task 71.

## 5. EVIDENCE CONFLICTS encontrados no relatório pré-implementação (2026-10-01)

Encontrados ao detalhar os pontos de captura aprovados. A implementação parou até a
decisão humana. Resolução: as quatro alternativas mínimas abaixo foram **aceitas** e
implementadas (log por ticket como fonte de verdade; `completed_by_journal_ids` só no
gate; `human_input_refs[]` opcional; `proposal_comment_id` ≠ `approval_journal_id`). No
mesmo passo ficou decidido que `HUMAN_AUTHORED` não é inferido no baseline: só entra por
declaração.

- **EC-1, Registry é índice derivado.** `scripts/lib/ac-registry.js:20-21` ("o registro é
  índice derivado, não histórico"); `scripts/rebuild-ac-registry.js:31-39` (reconstrói do
  zero, e do zero mesmo quando o registro atual está ilegível); `updateRegistry`/`buildEntry`
  substituem a entrada inteira; `.graph/ac-registry.json` é gitignored. Gravar `sources[]`
  só ali contradiz o append-only (item 20). Alternativa mínima: log append-only por ticket
  `memory/spec/<id>-ac-provenance.json` no checkout principal (mesmo padrão de
  `<id>-spec-changelog.json`) como fonte de verdade, e `ac_sources` no Registry como
  projeção que `updateRegistry`/`rebuild` recalculam a partir do log.
- **EC-2, `withSpecReplies` não materializa AC.** `scripts/readmine-watcher.js:1278-1286`,
  `:1756`, `:1834`: o conteúdo combinado (spec + comentários) só é validado e entra na
  `signature`; nunca é gravado na spec. Os `AC-NN` da spec vêm de outro lugar. Atribuir
  `REDMINE_COMMENT` a `(ticket, AC-NN)` ali seria inferência. Alternativa mínima: persistir
  `completed_by_journal_ids` no `<id>-spec-gate.json` (evidência no nível do ticket) e
  nenhuma entrada em `sources[]` de AC por esse ponto.
- **EC-3, human-input não tem vínculo estruturado com SPEC_CHANGE ou AC.** A proposta de
  `spec-change.js` só leva `rationale` em texto livre (43666/SC-001 cita o human input em
  prosa); `human_input_interpretations[]` não referencia AC. O `HUMAN_CLARIFICATION →
  SPEC_CHANGE` do 43666 não é demonstrável. Alternativa mínima: campo opcional
  `human_input_refs[]` (`message_hash`/`at`) no `decision.json` do `record`, validado contra
  `state.human_input_interpretations`/`human-input.processed.md`; na aprovação vira
  `HUMAN_CLARIFICATION/CLARIFICATION` antes do `SPEC_CHANGE/MODIFICATION`. O histórico fica
  só com `SPEC_CHANGE`.
- **EC-4 (correção, não bloqueia), 45411 é o comentário da proposta, não a aprovação.** O
  `comment_id` do audit é o journal que o watcher postou com a proposta (`posted_at`
  11:20:22, aprovação às 11:20:38). O journal da resposta `aprovado` existe em
  `reply.journal` (`readmine-watcher.js:2174-2194`), mas não é passado a
  `approveSpecChange`. Alternativa: passar e gravar `approval_journal_id`; a referência
  distingue `proposal_comment_id` de `approval_journal_id`.
