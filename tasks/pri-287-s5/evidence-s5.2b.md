# Evidência — PRI-311 S5.2b (PRI-287): comando de passo e integração

Adendo: `tasks/pri-287-s5/SPEC-s5.2.md` v2.1 (aprovado pelo Richard em 2026-11-09, Q8–Q14), sobre
`tasks/pri-287-s5/SPEC.md` v2.1. Escopo da S5.2b: passos 7 a 12 (B2, B5, B6, B8, H7); AC-22 a
AC-29 e AC-35. Base: `main` `886aff0` (S5.2a mergeada, PR #112).

A flag `decomposition: "on"` segue **reservada** (`DECOMPOSITION_RESERVED`,
`model-routing-policy.js`, não alterado): nenhuma Run real nasce decomposta. O ramo novo só abre
com um snapshot de admissão íntegro que traga `decomposition: "on"`, o que hoje só o harness monta.
Runs OFF e ON sem a chave seguem byte a byte iguais (golden AC-01 passa). RC-1 a RC-6 e
RRC-F31-001/002 seguem **NOT APPLIED**. WATCHER_QA_DIAGNOSTICO e o polling de PR não foram tocados.

**Gate do RC-1: NÃO CUMPRIDO** (texto do AC-27). A prova do U10-a existe (S5.2a,
`u10-probe-evidence.json`), mas cumprir ou dispensar o gate é decisão do Richard (Portas, item 1).
Nada no código ou nesta evidência o dá por cumprido.

## O que entrou

| Passo | Onde | O quê |
| -- | -- | -- |
| 7 (B2) | `scripts/lib/decomposition-visit.js` `recordDecomposition`; `readmine-watcher.js` `prepareDecomposedNode`; `.graph/schemas/state.schema.json` | `state.decomposition` gravado por `writeTaskState` (CAS) na 1ª visita; replan = versão nova com `superseded[]`; versão nova **só** depois de visita nova ao Plan (`plan_visits`), senão `blocked` `PLAN_CHANGED_OUTSIDE_PLAN`; intercalado/sem plano → `NOT_DECOMPOSABLE` e caminho da S4 |
| 8 (B5) | `nextAction`, `classFloor`, `groupSignals`, `preBuildDue`, `churnDue`; `model-routing.js` `classFloor`/`fixedRoute` | uma subtarefa por tick, na ordem do menor passo; resolução com os sinais só do grupo e `subtaskKey`; override humano prevalece; rework ≥ resolução inicial (classe da RoutingDecision do 1º Attempt da linhagem); pré-build uma vez antes da 1ª subtarefa; churn uma vez por visita; causa explícita (`dispatch`/`retry`); ato humano antes do retry; redespacho sem teto só para `STATUS_CHANGED` |
| 9 (B6) | `.claude/commands/implement-step.md`, `implement-integrate.md`; `deriveDod`, `stepContextBlock`, `integrationContextBlock` | comandos novos por referência ao `/implement` (que fica byte a byte igual); bloco de contexto com hash no Attempt (`context_record_sha256`); DoD derivado no prompt e no Attempt (`dod`), nunca gate |
| 10 (B5.6, H7) | `transitionDecomposedImplement`, `reviewAllowed`, ramo de gate em `prepareDecomposedNode` | integração no `default_route` (Q4); `aggregateImplement` → transição implement → review pelo watcher (`stateWriter.update`, `node_transition`, `expected_node: implement`); Review sem `aggregate:<pv>` → `blocked` `REVIEW_WITHOUT_AGGREGATE`; Review/Test/Verify da Run decomposta com `role = gate`, baseline e `post` |
| 11 (B5.7–8, Q7 a) | `mapFindings`, `pendingRework`, `scopeCheck`; `dom06-attempt.js` `recordScopeViolation`; `model-routing.js` | achado da Review com arquivo em `paths_decl` de exatamente um grupo → rework só dessa chave; sem mapeamento (ou Test/Verify) → `<pv12>/ALL` em **C4 exato** com `RISK_RECLASSIFIED`; `scope_violation` (contagem, sem caminho) → próximo Attempt da linhagem ≥ C4 com `RISK_RECLASSIFIED`, gravado também quando a classe já era ≥ C4 (m3); nunca `escalation`, proposta ou `authorization_ref` |
| 12 (B8) | `model-routing.js` `subagentRoles`, `subagentMechanism`, `observeSubagentRoles`, `routedArgs`; `readProjectAgents`; `dom06.recordSubagentObservation`; `finishCostRun` | `subagent_roles[]` em toda RoutingDecision de subtarefa/integração; `--agents` só com papel, com `subagent_roles` na policy e com o mecanismo VERIFIED (CLI 2.1.319, a da prova); só agentes do projeto reproduzíveis fielmente (troca só o `model`); `effort_enforcement = UNKNOWN`; `observed_model` depois da saída |

Registros: `ownership.yaml` (capacidade `decomposition-visit`) e `docs/concurrency-map.md`
(decomposição da visita, transição implement → review pelo watcher, registros pós-saída).

## Verificação por AC

| AC | Onde | Resultado |
| -- | -- | -- |
| AC-22 | `decomposition-watcher.test.js` "AC-26/AC-22" (watcher real): subtarefas em ordem, uma por tick, `/implement-step`; integração; transição só com `aggregate:<pv>`; Review uma vez, como gate; "AC-22: Review … sem agregação → blocked"; `decomposition-visit.test.js` "AC-22 (lib)" | PASS |
| AC-23 | combinação `needsPreBuildGate && preBuildDue` e `churnDue` no despacho; `decomposition-visit.test.js` "AC-23 (lib)" (pré-build uma vez; churn uma vez por visita, de novo na visita de rework) | PASS **no nível da lib** (o portão real roda Maven/git no watcher; no teste ponta a ponta o pré-build está desligado por `SKIP_PRE_BUILD_VALIDATION`) |
| AC-24 | `model-routing-decomposed.test.js` (classe por grupo; piso; override prevalece; ALL sem override de subtarefa); watcher: rework com a classe da linhagem | PASS |
| AC-25 | `decomposition-visit.test.js` "AC-25 (lib)" (mapeado, misto, sem arquivo, Test → ALL; rework uma vez por gate; k1 não refeita); `model-routing-decomposed.test.js` (ALL C4 exato; RISK com classe ≥ C4); "B5.8" com manifestos reais; watcher: volta de gate → rework só de k2 → nova integração → nova agregação | PASS (`scope_violation` → ≥ C4 provado na lib, não no watcher) |
| AC-26 | `decomposition-watcher.test.js` "AC-26/AC-22": modo destacado (sem `--follow`, release no wrapper `sh` → `node-lease.js release`), duas subtarefas + integração + agregação + transição + Review + rework + nova integração + transição | PASS |
| AC-27 | `model-routing-decomposed.test.js` (sem seção → `default` UNENFORCED; mecanismo só na 2.1.319; só agentes reproduzíveis ENFORCED; teto do argv; observação com `SUBAGENT_MODEL_MISMATCH`); watcher: `--agents` nos Attempts de subtarefa/integração e não no gate, só hash na decisão, prompt fora do Attempt | PASS. **Gate do RC-1: NÃO CUMPRIDO** (decisão do Richard) |
| AC-28 | `decomposition-visit.test.js` "AC-28" (DoD derivado e gravado; `decideAcceptance` igual com e sem itens não feitos); watcher: `dod` no Attempt | PASS |
| AC-29 | `decomposition-watcher.test.js` "AC-29": SHA-256 de `implement.md`, `review.md`, `commit.md` iguais aos de `2024597` | PASS |
| AC-35 | ver "Suítes" | ver abaixo |

## Suítes

Receita oficial (`docs/runbook.md`: `env -i`, HOME/TMPDIR sintéticos, `harness/loopback-only.cjs`,
`PRISMA_ROOT = REPO_PATH = checkout`), rodada final depois das correções da G3:

| Suíte | Node 22.23.2 | Node 24.22.1 |
| -- | -- | -- |
| `scripts` | 1920 testes: 1914 pass, 0 fail, 6 skipped (TAP sha256 `03dcad4feb601624`) | 1914 pass, 0 fail, 6 skipped (`770611ff3f112cd4`) |
| `dashboard` | 402/402 (`e13a8971b17d1322`) | 402/402 (`1b1ace5393ba4ca9`) |

`check:js`, `lint:src` e `arch:check` (Node 22.23.2): exit 0 nos três. Testes novos: 23
(`decomposition-visit.test.js` 11, `model-routing-decomposed.test.js` 8, `decomposition-watcher.test.js` 4).
CI Linux não rodou nesta sessão.

## Revisão G3 do código (Opus + Arquiteto, contexto limpo, só leitura)

- **Opus:** CHANGES_REQUESTED (MAJ-1…3, MIN-1…8, NIT).
- **Arquiteto:** APPROVED_WITH_CHANGES (A-01, A-02 MAJOR; A-03…A-08 MINOR; A-09, A-10 NIT). Conformidade
  confirmada com D3/D13/D14/D-9, AGENTS.md regra 4, DP-8, ALT-3/RC-2, RC-4, Q4, Q6 e reserva B1.

| Achado | Disposição |
| -- | -- |
| MAJ-1 / A-01 (redefinição por `--agents` perdia campos e podia ampliar ferramentas) | Corrigido: leitura estrita do frontmatter; só `name`, `description`, `tools` (linha única), `model`, `color` (cosmético, fora); lista YAML, bloco `>`/`|`, `disallowedTools` ou qualquer outro campo → agente **não** redefinido, UNENFORCED `AGENT_NOT_REPRODUCIBLE`. Teste com os três casos |
| A-02 / MIN-5 (`ENFORCED` sem ligação com a prova) | Corrigido: `subagentMechanism(cliVersion)` como capacidade (padrão do `effortMechanism`), VERIFIED só na 2.1.319; sem ela, UNENFORCED e sem `--agents`; `effort_enforcement = UNKNOWN`; `subagent_mechanism` na decisão |
| MAJ-2 / A-04 (ALL não em C4; RISK não gravado com classe ≥ C4) | Corrigido: ALL com classe C4 exata; RISK_RECLASSIFIED gravado sempre que o piso de risco se aplica |
| MAJ-3 / A-06 (Attempt STARTED sem lease travava a Run) | Corrigido: sem escrita no state depois do Attempt (resolução inicial lida da RoutingDecision do 1º Attempt, fonte DOM-06); Attempt com papel sem aceite e Run fora de `running` por mais de 2 min → fechado como órfão (`closeRoleOrphan`, regra H4) |
| A-05 (replan silencioso) | Corrigido: `plan_visits`; versão nova sem visita nova ao Plan → `blocked` `PLAN_CHANGED_OUTSIDE_PLAN` |
| A-07 (tamanho do argv) | Corrigido: teto de 64 KiB; acima, sem `--agents`, UNENFORCED `AGENTS_ARG_TOO_LARGE` |
| MIN-1 (`--follow` parava na transição) | Corrigido: laço do `--follow` continua com `transitioned` (sem teste dedicado em `--follow`, ver pendências) |
| MIN-2 (retomada humana como `retry`) | Corrigido: ato humano antes da regra de retry → `dispatch` |
| MIN-3 (redespacho sem teto) | Corrigido: redespacho só para `STATUS_CHANGED`; `CLAIM_LOST` e outros não aceitos sem ato humano → `blocked` |
| MIN-4 / A-08 (transição por `writeTaskState`) | Corrigido: `stateWriter.update` com `node_transition` e `expected_node: implement`; `current_agent` não é mais tocado |
| MIN-6 (piso só por classe) | Declarado: o piso é por classe da RoutingDecision do 1º Attempt; uma resolução inicial vinda de override não vira piso de tier/esforço |
| MIN-7 (ACs só na lib) | Parcial: rework (AC-25) e `--agents` com agente do projeto (AC-27) entraram no teste do watcher; AC-23, o teto/retry no watcher, `--follow` e Run revivida pela Recusa QA seguem provados só na lib ou na S5.2a (declarado na tabela) |
| MIN-8 (DRY_RUN) | Sem mudança: `prepareDecomposedNode` só roda depois do retorno antecipado de `DRY_RUN` em `dispatchTicketReserved` |
| A-03 (B5.9 × AC-25) | Registrado abaixo ("Desvios") |
| A-09 | Corrigido: `decision.subagent` = `PARTIAL` quando há linha ENFORCED; sem papel, `UNENFORCED` (legado da S4, golden intacto) |
| A-10 | Declarado: os agentes são lidos do worktree no despacho; o `subagent_agents_sha256` na decisão permite auditar mudança entre Attempts |
| NITs do Opus | `isDecomposedRun` removido; requires e `module.exports` reunidos; `rework_pending` mantido como defesa; bloqueios com `attempt_id` null declarados abaixo; DoD usa os ACs citados nos passos do grupo (`acs` da S2), equivalente a `coverage.<AC>.plan_steps ∩ passos` quando a matriz deriva do plano |

## Desvios declarados

- **B5.9 × AC-25 (A-03):** a B5.9 da SPEC v2.1 diz que, sem a S5.3, `scope_violation` é "só
  registrado (sem reclassificação)" e o rework fica "na mesma resolução". A Q7 (a), decidida pelo
  Richard em 2026-11-09, e os textos B5.7, B5.8, AC-25 e o passo 11 do adendo pedem `ALL` em C4 e
  `scope_violation` → ≥ C4 com `RISK_RECLASSIFIED`. A implementação segue a Q7 (a): a B5.9 vale
  só para `failure_class = null` e "sem proposta". Pede ciência do Richard; sem nova G3 de spec.
- **Núcleo 2 (Jev) não coletado por subtarefa:** a visita decomposta segue sem opinião do Jev
  (só registro). Afeta a comparabilidade com a S3b/S6.
- **`observed_model` em `subagent_observation`** (campo próprio do Attempt, gravado uma vez), não
  dentro da RoutingDecision, que fica imutável como decidida no despacho.
- **Vocabulário novo de `selection_source`:** `LINEAGE_FLOOR` (piso da linhagem).
- **Bloqueios sem Attempt** (`decomposition_block_applied.attempt_id = null`): cadeia quebrada no
  despacho, `REVIEW_WITHOUT_AGGREGATE`, `AGGREGATE_PENDING`, `PLAN_CHANGED_OUTSIDE_PLAN`. Saída humana
  pelo mecanismo existente (`unblocked`); se a causa persistir, o bloqueio volta.
- **Limite da B4 mantido:** `scope_violation` só vê o que o manifesto observa (tracked, untracked e
  ignorados dentro da união dos `paths_decl` e globs). Registros da plataforma em `memory/` não contam.
- **`--agents` só para agentes do projeto:** subagentes embutidos da CLI ficam na linha `default`,
  UNENFORCED (não verificados). Igualar os braços (Plan da Run decomposta, A0m) é condição da S6
  (Q13 a).

## Pendências (fora desta fatia)

- **Gate do RC-1:** decisão do Richard (cumprir com a prova do U10-a ou dispensar). Esforço do
  subagente (U1) e subagentes embutidos seguem não verificados.
- **C-A-08:** `subagent_roles.default` igual ao `default_route` na policy de piloto ou no PR de liberação.
- **Portas para ligar a flag** (SPEC): S5.3 (PRI-312) entregue ou dispensada; nova versão de policy
  aprovada; nota da Q7 na reconciliação (PRI-293).
- Teste dedicado em `--follow` da transição encadeada e da Run revivida pela Recusa QA na Run decomposta.

## Verify (nó aplicado manualmente)

- **Passos 0, 0b e 1 (scripts sobre `memory/runs/<task>`): N/A.** Trabalho interativo na
  plataforma, sem Run despachada da PRI-311 (como na S5.1 e na S5.2a). A conformidade foi conferida
  à mão: cada AC da S5.2b tem linha acima com teste nomeado, rodado na suíte final.
- **Passo 3 (escopo):** todos os arquivos do diff estão nos passos 7 a 12 do adendo ou são registro
  de dono/concorrência e schema. `plan-signals.js`, `implement.md`, `review.md`, `commit.md` e
  `model-routing-policy.js` não mudaram.
- **Passo 4 (risco do PR): high.** Liga o ramo decomposto no despacho do watcher, muda o argv
  roteado (atrás da flag) e cria um writer novo de transição de nó na Run decomposta. PR em draft.
