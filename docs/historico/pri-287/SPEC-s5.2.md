# Adendo de SDD: PRI-311 (PRI-287 S5.2): subtarefas no watcher, comando de passo e integração

> **Status:** **APROVADA (v2.1) pelo Richard em 2026-11-09 ("AUTORIZO")**, com as recomendações:
> Q8 (a) S5.2a + S5.2b como subfatias da PRI-311; Q9 proposta de policy aprovada (id e versão a
> critério do Richard); Q10 (a) tarefa 0 autorizada, com login do Richard no perfil isolado;
> Q11 (a); Q13 (a); Q14 (a). Nada implementado.
> G3 r1 sobre a v1: Opus CHANGES_REQUESTED (O-01…O-13, 9 MAJOR); Arquiteto APPROVED_WITH_CHANGES
> (A-01…A-11, 4 MAJOR); nenhum BLOCKER → v2. G3 r2 sobre a v2: Opus e Arquiteto
> APPROVED_WITH_CHANGES (R2-O-01…05, R2-A-01…06) → v2.1. A disposição está no fim.
> A flag `decomposition = on` continua **reservada** (`DECOMPOSITION_RESERVED`). RC-1 a RC-6 e
> RRC-F31-001/002 continuam **NOT APPLIED**. WATCHER_QA_DIAGNOSTICO e o polling não são tocados.
>
> **O que este adendo é.** A SDD que vale é `tasks/pri-287-s5/SPEC.md` **v2.1** (aprovada em
> 2026-11-09, Q1–Q7 decididas), que já fixa o comportamento da S5.2 (B2, B5, B6, B8; AC-22 a
> AC-29). Este adendo **não reabre** nada disso. Ele:
> 1. incorpora as **pendências que a S5.1 declarou para a S5.2** (`evidence-s5.1.md`) e as
>    ligações no watcher que a S5.1 deixou só como funções (baseline, `blocked`, cadeia);
> 2. detalha a **tarefa 0 (U10)** da Q2 (a) e a **nova versão de policy** de que a S5.2 depende;
> 3. reestima a S5.2 e, como passa de 5 pontos, propõe a divisão.
>
> Issue: [PRI-311](https://linear.app/prisma-app/issue/PRI-311) (filha da
> [PRI-287](https://linear.app/prisma-app/issue/PRI-287)). `roadmap-ref: UNKNOWN`.
>
> **Fontes:** `SPEC.md` v2.1; `evidence-s5.1.md` e `handoff-s5.1.yaml` (S5.1, PR #106, merge
> `cc72b55`); desenho v9 (`~/Workspace/prisma-evidence/pri-205/desenho-selecao-modelo.md`,
> SHA-256 `2d8919febfa6440f…`) §3.3–§3.5, §4.6, §4.9, §5.1; `plano-fatias.md` (`c346cb23b5139984…`);
> `ledger-hd-proposta.md` (HD-AF-078, `c6deede84ce16603…`); `hd-ativacao-final-proposta.md`
> (RC-1/DP-4a, RC-3/DP-8). Código lido em `main` `cc72b55`.

## Restrições respeitadas

| Ref | Como este adendo respeita |
| -- | -- |
| D3 (a), D13 (a) | Subtarefa = Attempt do nó Implement (M1), despacho separado; `execute_node` só pela agregação (SPEC B3, entregue na S5.1) |
| D14 (a)+(a) | Identidade `plan_version` + grupo (`subtask-decomposition.js`, S5.1); manifesto com HMAC por Run; aqui só se ligam baseline, `post`, cadeia e versão vigente no watcher |
| D-9 | A Run continua sendo a unidade: a decomposição mora no `state.json` da Run, pelo writer existente; nenhuma subtarefa vira Run, ticket ou fila |
| RC-1 / DP-4a | Subagente é uso por papel **dentro** do Attempt; `subagent_roles[]` na RoutingDecision; sem prova do U10, o gate do RC-1 segue não cumprido. Cumprir ou dispensar o gate é ato do Richard |
| DP-8 | DoD por subtarefa derivado e gravado como insumo; nunca aprova nem reprova (SPEC B6, AC-28) |
| ALT-3 (RC-2) | Sem escalonamento efetivo; sem a S5.3, `failure_class = null` e rework na mesma resolução, sem proposta (SPEC B5.9). `RISK_RECLASSIFIED` (Q7 a) é risco, não escalonamento |
| RC-4 | Review, Test e Verify uma vez, sobre o integrado, com o escopo de hoje; sem paralelismo |
| D15 | Indisponibilidade do provider redespachada como no controle, nos dois modos (H2) |
| AGENTS.md 4 | Sem engine, registry ou canal paralelo: reusa o loop do watcher, `prepareDispatch`, o lease, `writeTaskState` (CAS), `state-writer transition` e `notifyBlocked` |

## Ligações e pendências herdadas da S5.1

A S5.1 entregou o contrato fail-closed como funções. Hoje o watcher não grava baseline (só
`prepareDispatch` aceita `workspace_baseline`, `dom06-attempt.js:161`), não aplica o `blocked` a
partir do `acceptance` e não roda `chainCheck`. Sem H0 a H6, todo Attempt com papel fecha
`PLAN_VERSION_UNKNOWN` e a Run decomposta não anda.

### H0. Baseline no despacho de Attempt com papel

- No despacho de Attempt com `role`, o watcher chama `ensureKey`, `observe` no escopo da
  `plan_version` vigente (união dos `paths_decl` + `workspace_watch_globs`, SPEC B4) e
  `storeManifest(baseline)`. O arquivo local do baseline guarda também `scope_paths`,
  `watch_globs` e `limits`.
- O Attempt recebe `workspace.baseline` (digest, contagens, `completeness`) e
  `scope_hmac = HMAC(chave, escopo canônico)`: nunca o escopo nem caminho (A-07).

### H1. `post` e versão vigente nos dois caminhos de saída (C-O-07 / C-A-04)

- **Lease:** as **adições do DOM-06** ao lease são só `dom06ManifestsDir` e `task`. O lease já
  leva caminhos do consumidor (`dir`, `dom06AttemptFile`; `node-lease.js:84`,
  `readmine-watcher.js:3969-3974`) e vai no argv do `sh` destacado; a regra é **sem chave e sem
  escopo**, não "sem caminho". Origem de cada caminho no `exitContext`: worktree a partir de
  `lease.dir`; `checkoutRoot` e `keysDir` a partir de `dom06ManifestsDir`.
- **Escopo do `post`:** lido do arquivo local do baseline e conferido contra o `scope_hmac` do
  Attempt; divergência ou arquivo ausente → `post` UNKNOWN (`SCOPE_TAMPERED` /
  `BASELINE_MISSING`). **Limite declarado (R2-O-05):** a chave é legível pelo agente (limite já
  aceito na SPEC B4), então o `SCOPE_TAMPERED` pega alteração acidental, não adulteração
  deliberada.
- **Versão vigente sem corrida (O-02):** função nova `releaseNodeWithContext` devolve `{ reason,
  plan_version }`, com `plan_version` lido **dentro do mesmo callback** do `stateWriter.update`
  do release (`node-lease.js:141-148`), no mesmo snapshot do claim. `releaseNodeWithReason`
  continua devolvendo string (testes do AC-09, R2-O-02) e passa a delegar à nova.
  `STATE_MISSING`/`SESSION_CONFLICT` → sem versão → `PLAN_VERSION_UNKNOWN`. Um redecompor no tick seguinte não muda
  o que a saída enxerga.
- **Função única:** `exitContext({ lease, claim })` no DOM-06 monta `{ manifestPost,
  currentPlanVersion }`; os dois caminhos a chamam e passam o resultado a `closeOnExit`. Attempt
  sem `role` não chama nada disso (AS-IS, golden AC-01).
- **Ordem em `--follow` (O-03):** o release (claim + versão) continua no `exit` do processo;
  para Attempt com `role`, `closeOnExit` passa a rodar **depois do `drained`** do segmento, com
  `output` e `stderr` completos (H2). No modo destacado, o wrapper já roda depois da saída.
- Falha em qualquer passo → `manifestPost` UNKNOWN com causa; o aceite segue a tabela da SPEC.

### H2. Causa operacional e teto (AC-20, parte do watcher)

- Antes de congelar o `acceptance`, `closeOnExit` recebe `operational_cause =
  PROVIDER_UNAVAILABLE | SESSION_LIMIT | AGENT_FAILURE`, calculada por `looksUnavailable` e
  `looksLikeSessionLimit`, que saem do watcher para uma lib pura (mesmo texto, mesmas assinaturas).
- **Fontes:** em `--follow`, `output`/`stderr` depois do `drained` (completo). No modo destacado,
  **best-effort** (R2-O-01, R2-A-01): o log é por ticket, em append (`logPathFor`,
  `readmine-watcher.js:3230`), e quem escreve é o `sanitize-log` em processo próprio
  (`:3442-3456`). Por isso: (i) o lease grava `logOffset` (tamanho do log no spawn) e o
  `node-lease.js release` lê só a partir dele; (ii) espera o EOF do filtro por tempo limitado
  (o wrapper passa a esperar o filtro antes do `release`); (iii) causa indeterminada →
  `AGENT_FAILURE`, que conta no teto. **Resíduo declarado:** no destacado, uma indisponibilidade
  não detectada consome o teto (lado conservador: `blocked`, nunca retry sobre mutação); é a
  única diferença em relação ao controle, e é medida (m2).
- **Isenção do teto só sem mutação (O-04):** `PROVIDER_UNAVAILABLE` e `SESSION_LIMIT` não
  contam no teto **apenas** com `baseline` e `post` COMPLETE e iguais. Com mutação ou UNKNOWN →
  `blocked`, qualquer que seja a causa (um falso positivo de texto em log de build não redespacha
  sobre diff).
- `SESSION_LIMIT` em `--follow`: o writer existente grava `session_limit` e **prevalece**; o
  `blocked` do manifesto nunca o sobrescreve; a retomada humana pelo dashboard vira `HUMAN_RESUME`
  (H6). No modo destacado, o AS-IS não grava `session_limit` (só redespacha); o adendo mantém isso
  e só usa a causa para a isenção.
- **Mudança declarada em `decideAcceptance` (R2-O-03):** hoje o teto é por linhagem (pai com
  `retry_allowed` → `RETRY_CEILING`, `dom06-attempt.js:533-538`). Passa a ignorar, na contagem,
  pai cuja `operational_cause` é isenta e que fechou sem mutação. O Attempt depois de
  `HUMAN_RESUME` entra com causa `dispatch` e `chain_anchor`, não `retry`: não consome o teto.

### H3. Seções novas da policy (C-A-09)

`model-routing-policy.js` aceita três seções **opcionais**, validadas só com `mode = ON`:

| Seção | Forma e validação | Ausente |
| -- | -- | -- |
| `subagent_roles` | `{ "<papel>": { "model_id", "effort" } }`; papel = sintaxe de nome de agente (`[a-z0-9-]+`) ou `default`; `model_id` por `isRealModel`, como as demais seções (`model-routing-policy.js` ~171-175); `effort` no enum de esforço ou `"UNKNOWN"` com `effort_ref` | `subagent_roles[]` gravado com `declared_model = null`, `enforcement = UNENFORCED` |
| `manifest_limits` | `{ "max_entries": int > 0, "max_bytes": int > 0 }` | 20 000 entradas e 256 MiB (P-5) |
| `workspace_watch_globs` | `["<glob>", …]`, sem caminho absoluto nem `..` | `[]` |

- `default` = qualquer papel não listado, **inclusive os subagentes embutidos da CLI** (A-05).
- A validade não depende do worktree do consumidor: só sintaxe (A-05, O-11). Papel listado que
  o projeto não tem não é erro.
- Forma inválida com `mode = ON` → bloqueio do RC-5 sem Run. As seções mudam o hash da policy
  (o hash é dos bytes, `:338`). Projeto OFF não lê nada.

### H4. Órfão (C-A-10)

- `recoverOrphans` acha o Attempt do nó por `latestBound(runDir, node, { role })`
  (`dom06-attempt.js:210-219`, último por `seq`) e confirma `result === 'STARTED'` (R2-O-04).
- Para Attempt órfão **com** `role`, chama `closeOrphan` (S5.1) antes do redespacho:
  - `orphanReason = agent_dead` (pid gravado e morto): manifesto corrente no escopo do baseline
    (H1); sem mutação → regra do teto (um retry); mutação ou UNKNOWN → `blocked`;
  - `orphanReason = timeout` (sem pid, agente pode estar vivo e escrevendo,
    `node-lease.js:258-265`): **sempre** `blocked` (O-06). **Divergência conservadora declarada**
    em relação à SPEC B3/AC-10, que não distingue o tipo de órfão (R2-A-05).
- Fecha `UNCERTAIN`; nunca reaplica efeito de resultado incerto. Conflito de CAS no `writeState`
  deixa o órfão para o próximo startup, idempotente. Órfão sem `role`: caminho de hoje, byte a byte.

### H5. Chave e retenção (C-A-10)

- **Run arquivada não é terminal:** o retry de Recusa QA traz a mesma task de volta do `_archive`
  (`readmine-watcher.js:376-384`, `consumeQaRetrySignals`). A Run revivida é **a mesma Run**
  para a D14 (mesma task, HMAC por Run), então a chave **não** é apagada no arquivamento
  (R2-A-06). A rotação para `memory/archive/` não revive Run (`:595-600`).
- **Varredura do watcher** (startup), idempotente, apaga `_dom06-keys/<task>.key` e
  `_dom06-manifests/<task>/` só quando a task **não tem diretório de Run em nenhuma raiz**:
  `memory/runs` e `memory/runs/_archive` do checkout principal e de cada worktree do pool
  (as mesmas raízes de `recoverOrphanedNodes`), respeitando `taskScopeFilter`. Na prática, depois
  que `cleanup-runs` rotaciona o `_archive` para `memory/archive/`.
- **Corrida com Run nova da mesma task:** chave apagada por engano → `KEY_MISSING` → UNKNOWN →
  `blocked` (fail-closed). A varredura é novo **dono de exclusão** desses dois diretórios:
  entra em `ownership.yaml` e `docs/concurrency-map.md` (A-06).
- **Run revivida pela Recusa QA:** o worktree é novo e o baseline do primeiro Attempt manifestado
  não bate com o último `post`. Sem reancoragem nova (a SPEC fecha a lista): a Run vai a `blocked`
  e segue por `HUMAN_UNBLOCK` (Q14).
- Manifestos nunca vão para o `_archive` (estão fora do worktree, `.gitignore:17`).

### H6. Writer do `blocked` e cadeia no despacho (B4, ligação no watcher; O-08)

- **`blocked` a partir do `acceptance`:** no tick, o watcher lê o último Attempt com `role` da
  Run; `acceptance.accepted = false` com sinal de `blocked` → `writeTaskState` (CAS) +
  `notifyBlocked` uma vez por assinatura, pelo mesmo caminho da recusa de roteamento da S4
  (`refuseRoutedNode`). Vale para o modo destacado no tick seguinte. Precedência: nunca
  sobrescreve `session_limit` nem status gravado pelo comando (SPEC B4).
- **Cadeia no despacho:** antes de todo Attempt com `role`, o watcher roda `chainCheck` contra o
  `post` do Attempt manifestado imediatamente anterior da Run e grava `chain_anchor` quando for
  reancoragem: `RUN_START` (sem anterior), `SCOPE_CHANGED` (replan; `scopeChangedCheck`),
  `HUMAN_UNBLOCK` (marcador `unblocked`, `by` do registro) e `HUMAN_RESUME` (retomada de
  `session_limit` pelo dashboard ou aprovação de SPEC_CHANGE/autorização, `by` do registro).
  Diferente sem reancoragem válida, ou `post` anterior UNKNOWN → `blocked` (writer acima).

### H7. Manifesto nos gates (Q6 a), na S5.2b

Na Run decomposta, Review, Test e Verify gravam baseline (H0) e `post` (H1) com `role = gate`.
`post` UNKNOWN não muda o veredito; só bloqueia o Attempt seguinte pela cadeia (H6). Depende da
B2 (Run decomposta), por isso fica na S5.2b.

## Tarefa 0: verificação do mecanismo U10 (Q2 a)

**Pergunta:** existe mecanismo verificável para fixar o modelo (e o esforço) do subagente, por
papel, no despacho roteado, sem depender do frontmatter que o LLM aciona?

| Id | Mecanismo | Observação |
| -- | -- | -- |
| U10-a | `--agents '<json>'` no argv do despacho, redefinindo cada papel com o `model` da policy | A CLI instalada lista a flag. **Hipótese registrada:** a precedência pode favorecer `.claude/agents/` do projeto (O-10); o controle detecta |
| U10-b | variável de ambiente que fixa o modelo de todo subagente | Não cobre papel a papel; comportamento a verificar |
| U10-c | reescrever o frontmatter `model:` no worktree | **Descartado:** muda arquivo do consumidor e mistura com o diff |

**Observação por papel (O-09).** A trilha `usage[]` da S1 agrupa por modelo e por `role`, e o
transcript de subagente entra sempre como `role: 'subagent'` (`readmine-watcher.js:3734`,
`cost-tracking.js:333`): não dá o papel. A tarefa 0 estende a S1 para casar cada
`subagents/*.jsonl` com o papel pelo `subagent_type` do `tool_use` correspondente no transcript
principal. A mesma extensão alimenta o `observed_model` do B8, **com ou sem a prova**: por isso é
passo próprio da S5.2a (passo 0b), independente do «sim» da tarefa 0 (R2-A-03). Sem casamento
inequívoco, a linha fica `CONFLICTED` e não conta como prova.

**Protocolo** (repositório git sintético, sem código nem dado do consumidor):

1. **Isolamento do perfil (A-03, R2-A-02):** `CLAUDE_CONFIG_DIR` próprio para a prova (não o
   `~/.claude-personal`), fora do repositório e apagado ao fim; o login nesse perfil é feito
   **pelo próprio Richard**, e nenhuma credencial é copiada, lida ou registrada pelo agente; com o plugin `jev-model-router` **desligado provado** pela prova de
   plugin da S4 (`evaluatePluginProof`), sem MCP, sem memória, sem CLAUDE.md nem hooks do
   usuário. Versão da CLI e argv completo registrados na evidência.
2. Dois papéis com frontmatter `model:` **diferente** do declarado na policy de fixture.
3. **Controle negativo:** um despacho sem o mecanismo, para mostrar que a observação vê o modelo
   do frontmatter (a medição detecta divergência).
4. Um despacho por candidato, prompt fixo que aciona os dois papéis; prova = `observed_model ==
   declared_model` nos dois papéis em **duas** execuções seguidas.
5. **Teto:** no máximo 6 chamadas `claude -p` no total (controle + 2 candidatos × 2 execuções +
   1 de folga). Execução que falhar ou ficar incerta **não é repetida** sem novo «sim».
6. Evidência só agregada (papel, declarado, observado, contagem, execução); sem transcript.

**Status do probe (A-10):** `scripts/probes/u10-subagent-model.js` é verificação pontual: sem
estado de Run, sem Attempt, sem RoutingDecision, fora do watcher e do DOM-06, e **excluído do
harness** (loopback-only). Não é canal de despacho.

**Resultado (A-08):** a evidência registra "prova obtida" ou "prova não obtida/não autorizada",
nunca "gate cumprido". Cumprir ou dispensar o gate do RC-1 é ato do Richard, citado no PR de
liberação (Portas, item 1). Sem prova: `enforcement = UNENFORCED` e `SUBAGENT_MODEL_MISMATCH`
observado, sem invalidar Attempt. Com prova, o mecanismo entra no `routedArgs` (S4) só para
Attempts com `role` e só com `subagent_roles` na policy; os demais argv ficam iguais (AC-01).

## Nova versão de policy (pré-requisito, decisão do Richard)

A policy aprovada `routing-pri205@p1-2026-11-06` mora no projeto consumidor e não muda aqui.
Proposta de conteúdo para a versão nova (Q9):

- `subagent_roles`: só a entrada `default`, com `model_id` e `effort` **iguais** aos do
  `default_route` (v9 §5.1: "subagentes iguais nos dois braços, no `default_route`"; D6 pede id e
  esforço fixos e registrados). A validação da policy de piloto confere a igualdade, para não
  haver deriva entre papéis (A-04 iii). Se o mecanismo não fixar esforço de subagente,
  `effort = "UNKNOWN"` com referência ao U1.
- `manifest_limits`: `{ max_entries: 20000, max_bytes: 268435456 }`.
- `workspace_watch_globs`: `[".env", ".env.*"]`.
- Id e versão: do Richard (o código só lê `policy_ref`).

**Cobertura (A-04 i):** a S5.2 aplica o mecanismo só a Attempts com `role`. O Plan da Run
decomposta e o braço de controle A0m (Attempts sem `role`) continuam com o subagente pelo
frontmatter. Igualar os braços é condição da S6 (D15, v9 §5.1), não desta fatia: Q13.

## Plano de implementação

| # | Passo | Arquivos | ACs | Fatia |
| -- | -- | -- | -- | -- |
| 0a | Tarefa 0 (U10), só com «sim» | `scripts/probes/u10-subagent-model.js` (novo) | AC-41 | a |
| 0b | Extensão da S1: papel do subagente por `subagent_type` | `cost-tracking.js` | AC-45 | a |
| 1 | H3 seções da policy | `model-routing-policy.js`, `config-validator.js` | AC-38 | a |
| 2 | H0 baseline + `scope_hmac` no despacho com `role` | `dom06-attempt.js`, `readmine-watcher.js` | AC-44 | a |
| 3 | H1 `exitContext`, versão no CAS do release, ordem pós-`drained` | `dom06-attempt.js`, `node-lease.js`, `readmine-watcher.js` | AC-36 | a |
| 4 | H2 causa operacional (lib pura) e isenção sem mutação, dois modos | lib nova de sinais de saída, `node-lease.js`, `readmine-watcher.js` | AC-37 | a |
| 5 | H6 writer do `blocked` e cadeia/reancoragens no despacho | `readmine-watcher.js` | AC-42, AC-43 | a |
| 6 | H4 órfão e H5 varredura | `node-lease.js`, `readmine-watcher.js`, `workspace-manifest.js`, `ownership.yaml`, `docs/concurrency-map.md` | AC-39, AC-40 | a |
| 7 | B2 decomposição da visita no `state.json` | `readmine-watcher.js`, `.graph/schemas/state.schema.json`; usa `subtask-decomposition.js`, **sem tocar `plan-signals.js`** | AC-22 | b |
| 8 | B5 sequenciamento: portões, resolução por grupo, override, causa explícita, decisão do teto | `readmine-watcher.js`, `model-routing.js` | AC-20 (watcher), AC-23, AC-24 | b |
| 9 | B6 comandos, bloco de contexto e DoD | `.claude/commands/implement-step.md`, `implement-integrate.md` (novos) | AC-28, AC-29 | b |
| 10 | B5.6 integração, agregação, transição pelo watcher, defesa da Review; H7 manifesto nos gates | `readmine-watcher.js`, `ownership.yaml`, `docs/concurrency-map.md` | AC-22, AC-26 | b |
| 11 | B5.7–8 rework mapeado, `ALL` em C4, `scope_violation` ≥ C4 (Q7 a) | `readmine-watcher.js`, `model-routing.js` | AC-25 | b |
| 12 | B8 `subagent_roles[]` gravado (com ou sem prova) | `model-routing.js` | AC-27 | b |

A S5.2a testa tudo com **Attempts injetados pelo harness** nos dois caminhos de saída, sem
despacho de subtarefa; o ciclo completo fica no AC-26 (S5.2b). A reserva
`DECOMPOSITION_RESERVED` continua no código nas duas fatias.

## Critérios de aceite

Mantidos da SPEC v2.1: **AC-22 a AC-29** e **AC-35** (S5.2b; AC-35 também na S5.2a).
Novos (S5.2a):

- **AC-36** (H1) Attempt injetado com `role`, fechado pelos dois caminhos (`--follow` e
  wrapper destacado), dá o mesmo `acceptance`; as adições do DOM-06 ao lease são só
  `dom06ManifestsDir` e `task` (sem chave nem escopo); `post` no escopo do baseline; arquivo de
  baseline alterado → `SCOPE_TAMPERED`; redecomposição entre o release e o `closeOnExit` não muda
  a versão usada; versão superada antes do release → `PLAN_SUPERSEDED`; em `--follow`,
  `closeOnExit` roda depois do `drained`; Attempt sem `role` igual ao golden AC-01.
- **AC-37** (H2) Indisponibilidade e `session_limit` sem mutação não consomem o teto (pai isento
  ignorado em `decideAcceptance`; retomada por `HUMAN_RESUME` entra como `dispatch`); com mutação ou
  UNKNOWN → `blocked`; em `--follow`, `session_limit` prevalece sobre o `blocked`. No destacado:
  só o log a partir de `logOffset` é lido (texto de despacho anterior não isenta); causa
  indeterminada → `AGENT_FAILURE`, conta no teto.
- **AC-38** (H3) Seções ausentes → padrões; forma inválida com `mode = ON` → recusa RC-5 sem Run;
  `model_id` irreal recusado; papel inexistente no projeto não é erro; projeto OFF com seções
  inválidas → nada muda.
- **AC-39** (H4) Órfão com `role`: `agent_dead` sem mutação → um retry; `agent_dead` com mutação
  ou UNKNOWN → `blocked`; `timeout` → `blocked`; sempre `UNCERTAIN`; órfão sem `role`: teste
  existente de `recoverOrphans` passa sem mudança.
- **AC-40** (H5) Run em `_archive` mantém a chave; task sem Run em nenhuma raiz → chave e
  manifestos apagados, idempotente; Run revivida pela Recusa QA → `blocked` até `HUMAN_UNBLOCK`;
  chave apagada sob Run viva → `KEY_MISSING` → `blocked`.
- **AC-41** (tarefa 0) Evidência agregada com controle negativo, perfil isolado (plugin desligado
  provado), versão da CLI e argv, ou registro de que a prova não foi autorizada/obtida; a
  evidência diz "prova obtida/não obtida", nunca "gate cumprido".
- **AC-42** (H6) `acceptance` não aceito → `blocked` + um `notifyBlocked` por assinatura, nos dois
  modos (destacado no tick seguinte); nunca sobrescreve `session_limit` nem status do comando.
- **AC-43** (H6) No despacho: cadeia igual → segue; diferente sem reancoragem → `blocked`;
  `RUN_START`, `SCOPE_CHANGED` (com e sem mudança no escopo antigo), `HUMAN_UNBLOCK` e
  `HUMAN_RESUME` gravados com `chain_anchor` e `by`.
- **AC-44** (H0) Baseline gravado no despacho com `role`; o Attempt tem digest, contagens,
  `completeness` e `scope_hmac`, sem caminho nem escopo; o arquivo local tem o escopo.
- **AC-45** (passo 0b) Cada `subagents/*.jsonl` casado com o papel pelo `subagent_type`; sem
  casamento → `CONFLICTED`; agregados legados, `usage[]` e `read_order` existentes iguais
  antes e depois (v9 R3-01).

## Estimativa e divisão

| Bloco | Pontos |
| -- | -- |
| S5.2 original da SPEC (B2, B5, B6, B8) + H7 | 5 |
| H0 a H6 (ligações e pendências herdadas) | 4 |
| Tarefa 0 (U10, extensão da S1 por papel) + seções da policy | 1 |
| **Total** | **10 (faixa 9 a 12)** |

Base: a S5.1 (5 pontos) precisou de duas rodadas de G3 de código; a S4 precisou de dois PRs de
correção no despacho. A v1 estimava 8; a G3 mostrou que baseline, `blocked` e cadeia não estavam
ligados no watcher (O-07, O-08).

Passa de 5. A divisão pedida na issue-mãe era "(a) contrato + manifesto e (b) comando de passo +
`failure_class`". O `failure_class` já é fatia própria (PRI-312, S5.3, 3 pontos); juntá-lo levaria
a (b) a 8. Proposta equivalente, sem mexer na S5.3:

| Fatia | Conteúdo | ACs | Pontos |
| -- | -- | -- | -- |
| **S5.2a: contrato + manifesto ligados** | Passos 0a a 6 (tarefa 0, extensão da S1, H0 a H6, policy) | AC-36 a AC-45, AC-35 | 5 |
| **S5.2b: comando de passo e integração** | Passos 7 a 12 (B2, B5, B6, B8, H7) | AC-22 a AC-29, AC-35 | 5 |
| S5.3 (sem mudança): `failure_class` + proposta | B7, B9 | AC-30 a AC-34 | 3 |

**Fechamento no Linear (A-09):** com duas subfatias na mesma issue, o merge do 1º PR pode fechar a
PRI-311 sozinho (precedente: PRI-181). Mitigação: PRs sem palavra de fechamento ("Refs PRI-311",
não "Fixes"), conferência do status depois de cada merge e reabertura se fechar.

## Perguntas para o Richard

| ID | Pergunta | Opções | Recomendação |
| -- | -- | -- | -- |
| Q8 | Divisão da S5.2 | (a) S5.2a (5) + S5.2b (5) como subfatias da PRI-311 (dois PRs draft, mitigação do auto-close); (a') as mesmas, como duas filhas novas da PRI-287; (b) uma fatia só de 10 pontos | **(a)** |
| Q9 | Conteúdo da nova versão de policy | aprovar a proposta acima / ajustar | aprovar; id e versão a seu critério |
| Q10 | Rodar a tarefa 0: até 6 chamadas reais ao provider, perfil isolado fora do repositório (login feito por você, nenhuma credencial tocada pelo agente, apagado ao fim), plugin desligado provado, repositório sintético, sem repetir execução incerta, evidência só agregada | (a) sim; (b) não agora: prova não obtida e registrada | **(a)** |
| Q11 | Retenção dos manifestos locais | (a) até a task sumir de todas as raízes (H5); (b) N dias depois | **(a)** |
| Q13 | Subagentes no Plan da Run decomposta e no braço A0m (sem `role`) | (a) fica como condição da S6 (D15), registrada por comentário na PRI-288 (S6) e na PRI-287 (R2-A-04); (b) estender o mecanismo a todo despacho roteado já nesta fatia (muda argv de Attempt sem `role`, quebra o golden AC-01) | **(a)** |
| Q14 | Run revivida pela Recusa QA numa Run decomposta | (a) `blocked` até `HUMAN_UNBLOCK` (sem mudar a SPEC); (b) nova reancoragem `QA_RETRY` (delta da SPEC v2.1, nova G3) | **(a)** |

A Q12 da revisão (desvio do modo destacado) **não é necessária**: o H2 detecta indisponibilidade
pelo log do nó também no modo destacado (best-effort, com offset e espera do filtro). O resíduo
fica declarado no H2.

## Premissas (valem se você não corrigir)

- P-7 A S5.2 não toca `plan-signals.js` (o checkout principal tem mudança não commitada de outra
  sessão nesse arquivo); a intercalação já está em `subtask-decomposition.js`.
- P-8 `implement.md`, `review.md` e `commit.md` ficam byte a byte iguais (AC-29 e golden).
- P-9 Nenhum consumidor real recebe a nova policy nem a flag nestas fatias.
- P-10 `seq` por varredura segue único porque a S5 é sequencial (pendência da S5.1, O-13).

## Riscos e UNKNOWNs

- U10 pode não ter mecanismo verificável: a prova fica não obtida e a S6 depende disso (D15 volta
  ao Richard entre (b) e (c), v9 §5.1).
- Subagentes embutidos da CLI podem não aceitar redefinição: `SUBAGENT_MODEL_MISMATCH` observado.
- Detecção por texto (`looksUnavailable`) tem falso positivo; contido pela isenção só sem mutação.
- Run revivida pela Recusa QA vai a `blocked` (Q14 a): mais intervenção humana com a flag ligada.
- `MAX_FOLLOW_SEGMENTS = 30` com k alto: estourar pára como hoje (risco já na SPEC).
- O watcher passa a transicionar implement → review na Run decomposta e a apagar chaves:
  novos donos registrados em `ownership.yaml` e `docs/concurrency-map.md`.

## Disposição dos achados da G3 (rodada 1, v1)

| Achado | Disposição |
| -- | -- |
| O-01 / A-11 | H1 e AC-36: "adições do DOM-06 ao lease", regra = sem chave e sem escopo; origem de cada caminho |
| O-02 | H1: `plan_version` lido no callback do `stateWriter.update` do release |
| O-03 | H1/H2: `closeOnExit` de Attempt com `role` depois do `drained`; causa antes de congelar |
| O-04 | H2: isenção só sem mutação, manifestos COMPLETE |
| O-05 / A-06 | H5: chave mantida no `_archive`; varredura só sem Run em nenhuma raiz; Run revivida → Q14; novo dono registrado |
| O-06 | H4: `timeout` → `blocked`; `latestBound` acha o Attempt; CAS idempotente |
| O-07 / A-01 | H0 na S5.2a; AC-36 com Attempts injetados; H7 e decisão do teto na S5.2b; S5.2a 5 pontos |
| O-08 | H6 e AC-42/AC-43 (writer do `blocked`, cadeia e reancoragens no despacho) |
| O-09 | Tarefa 0: casamento por `subagent_type`, controle negativo, `CONFLICTED`, extensão da S1 |
| O-10 | Tarefa 0: hipótese de precedência registrada |
| O-11 / A-05 | H3: `isRealModel`, papel só por sintaxe, `default` cobre embutidos |
| O-12 / A-02 | H2: detecção pelo log no modo destacado; Q12 dispensada |
| O-13 | P-10 |
| A-03 | Tarefa 0 passos 1 e 5; Q10 reescrita |
| A-04 | H3 `effort`; policy com igualdade ao `default_route`; Q13 |
| A-07 | H0/H1: `scope_hmac` e `SCOPE_TAMPERED` |
| A-08 | Tarefa 0 "Resultado"; AC-41 |
| A-09 | Mitigação do auto-close; Q8 |
| A-10 | Tarefa 0 "Status do probe" |

## Disposição da G3 rodada 2 (v2 → v2.1)

Opus r2: APPROVED_WITH_CHANGES. Arquiteto r2: APPROVED_WITH_CHANGES (só MINOR/NIT).

| Achado | Disposição |
| -- | -- |
| R2-O-01 (MAJOR) / R2-A-01 | H2: modo destacado best-effort com `logOffset`, espera do filtro, `AGENT_FAILURE` por padrão; resíduo declarado; AC-37 |
| R2-O-02 | H1: `releaseNodeWithContext` nova; `releaseNodeWithReason` segue string |
| R2-O-03 | H2: mudança em `decideAcceptance` declarada; `HUMAN_RESUME` como `dispatch`; AC-37 |
| R2-O-04 | H4: `latestBound(…, { role })` + `STARTED` |
| R2-O-05 | H1: limite do `scope_hmac` declarado |
| R2-A-02 | Tarefa 0 passo 1 e Q10: login do Richard, sem credencial, perfil apagado |
| R2-A-03 | Passo 0b e AC-45, independentes do «sim» |
| R2-A-04 | Q13: registro na PRI-288 e na PRI-287 |
| R2-A-05 | H4: divergência conservadora declarada |
| R2-A-06 | H5: Run revivida = mesma Run para a D14 |
