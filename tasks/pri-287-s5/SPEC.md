# Spec: PRI-287 (PRI-205 S5): decomposição do Implement em subtarefas como Attempts (A2, M1)

> **Status:** **APROVADA (v2.1) pelo Richard em 2026-11-09 ("AUTORIZO")**, com as recomendações:
> Q1 (a) três filhas; Q2 (a) tarefa 0 da S5.2 verifica U10, sem prova o gate RC-1 fica não
> cumprido; Q3 **corrigida em 2026-11-09**: a PRI-293 **não** é pré-condição (D-6 decidida pelo
> Richard em 27/10: "basta a HD-AF-078 para liberar as fatias S4 em diante"; a v2.1 tinha citado
> a recomendação anterior do Arquiteto por engano); Q4 (a); Q5 m1–m5
> aprovadas como registro, sem limiar; Q6 (a). **Q7 (a) decidida pelo Richard em 2026-11-09**
> (reclassificação por escopo e rework `ALL` como risco, `RISK_RECLASSIFIED`). Nada implementado.
> G3 r1: CHANGES_REQUESTED nos dois revisores (Opus O-01…O-21; Arquiteto A-01…A-15) → v2.
> G3 r2: Arquiteto APPROVED_WITH_CHANGES (R2-A-01…05); Opus CHANGES_REQUESTED só no delta
> (R2-O-01…07, "basta conferir esses pontos"). A v2.1 corrige os 12; a disposição está no fim.
> Não é Ready da issue. RC-1 a RC-6 e RRC-F31-001/002 continuam **NOT APPLIED**.
> Não altera o desenho v9, a F13, o Roadmap nem a policy aprovada
> `routing-pri205@p1-2026-11-06`. `roadmap-ref: UNKNOWN`.
> Issue: [PRI-287](https://linear.app/prisma-app/issue/PRI-287) (substitui a PRI-234).
>
> **Fontes:** desenho v9 (`~/Workspace/prisma-evidence/pri-205/desenho-selecao-modelo.md`,
> SHA-256 `2d8919fe…`) §3.1, §3.3–§3.5, §4.6, §4.7, §4.9, D3, D13, D14, D22, **com as
> disposições da HD-AF-078** (o delta formal do v9, D-8, não foi produzido; os casos de aceite
> da S5 escritos no v9 §4.6 sobre o Attempt `escalation` estão superados pela ALT-3);
> `plano-fatias.md` (SHA-256 `c346cb23…`); `ledger-hd-proposta.md` (HD-AF-078, errata §6);
> `hd-ativacao-final-proposta.md` (RC-1/DP-4a, RC-3/DP-8); `plano-aplicacao-rcs.md` (D-6, D-9);
> `tratamento-unknowns-hd-final.md` (errata §6). Código em `main` `2024597`.

## Contexto

Com `routing.mode = ON`, o Implement roda hoje num Attempt só, na classe **máxima** dos
grupos do plano (`model-routing.js` `classifyImplement`). Os grupos existem desde a S2:
`plan-signals.js` calcula `plan_version` (SHA-256 do bloco `## Plano de execução`
normalizado) e `groupSteps` faz o fecho transitivo por arquivos em comum, com
`subtask_key = <pv[0:12]>/<menor>-<maior>`. O fecho pode gerar grupos **intercalados**
(por exemplo `{1,3}` e `{2}`). O override humano da S4 já aceita escopo `subtask`. O
DOM-06 já reserva a causa `escalation` e valida a forma de `escalation_proposal`, sem produtor.

Fatos do código que a v1 errou ou omitiu e que moldam a v2:

| Fato (verificado em `2024597`) | Consequência |
| -- | -- |
| O diretório da Run é `<worktree>/memory/runs/<task>` (`readmine-watcher.js:913-915`, `taskRunsDir`) | Chave HMAC e manifestos com caminhos **não** podem ficar no diretório da Run (B4) |
| A transição implement → review é feita pelo **agente**, com `state-writer transition` (`implement.md:140-142`); o watcher manda parar no último comando (`readmine-watcher.js:4015-4021`) | `execute_node` "só pela agregação" exige que a transição passe a ser do watcher na Run decomposta (B5) |
| Sem `--follow`, a saída do agente é tratada pelo wrapper sh (`readmine-watcher.js:3393-3396`) que roda `node-lease.js release`, que chama `fulfillOnExit` (`node-lease.js:352-380`) | A lógica de saída da subtarefa tem de ser uma função do DOM-06 chamada pelos dois caminhos (B3) |
| Não existe teto de retry operacional nem autorização de retry no código: exit ≠ 0 libera o lease e o próximo tick redespacha (`causeFromState`, `dom06-attempt.js:211-219`). `retries` só existe para as voltas de gate (`graph.yaml:65-76`, `max_retries: 3`) | A v2 define teto e writer do `blocked` (B4) |
| `needsPreBuildGate` usa `history` sem `implement`; `needsChurnGate` roda a cada despacho do implement (`readmine-watcher.js:2943-2951`, `:3147`) | A v2 define cada portão por visita ou por Attempt (B5) |
| `readRoutingConfig` devolve OFF antes de ler outras chaves (`model-routing-policy.js:301`); a admissão e o check usam a mesma função | Nenhuma chave nova pode bloquear projeto OFF (B1) |
| `routing-off-golden.test.js` cobre só argv/env em OFF | É preciso um golden novo de Run ON (AC-01) |
| O esforço não é aplicado em produção (U1; `model-routing.js:31-35`) | Proposta registra `effort_applied` (B7) |

**Enquadramento da HD-AF-078 (ALT-3).** Nenhuma subida de tier é automática por falha.
Nesta fatia, falha `capacidade` gera só **registro de proposta** (sem `authorization_ref`) e
o retrabalho segue **na mesma resolução**. O Attempt `escalation` efetivo é da S5b (PRI-290).

## Objetivo

Numa Run admitida com `routing.mode = ON` **e** `routing.decomposition = on` no snapshot, o
nó Implement executa cada grupo do plano como Attempt próprio do nó
(`execute_subtask:<subtask_key>`), em sequência, cada um com a RoutingDecision **da classe
do grupo**. Depois, um Attempt de integração (`integrate:<plan_version>`) faz a
autoverificação. O watcher cumpre `execute_node` pela agregação e só então transiciona para
a Review. Review, Test e Verify rodam uma vez, sobre o integrado, com o escopo de hoje.
Todo Attempt da Run decomposta grava manifesto do workspace; retry automático só sem
mutação observada. Na volta de um gate, `failure_class` determinística (§4.9); `capacidade`
gera proposta e retrabalho na mesma resolução.

**Com a flag ausente ou `off`, nada muda** (golden de Run ON, AC-01).

## Decisões que esta SDD respeita

| Ref | Proveniência | O que fixa aqui |
| -- | -- | -- |
| D3 (a), D13 (a), D14 (a)+(a) | v9 e HD-AF-078 (APPROVED 26–27/10) | M1; subtarefa = Attempt do nó; obrigações `execute_subtask`/`integrate`; `execute_node` só pela agregação; identidade `plan_version` + grupo; manifesto com HMAC por Run, regra conservadora |
| D-9 | Restrição do Richard no pedido desta sessão (09/11): "a Run continua sendo a unidade" | Subtarefa é parte da execução do nó; RRC-XC-002 intacto |
| RC-1 / DP-4a | HD-AF-078; "gate só na S5" | Subagente por papel dentro do Attempt; **gate não cumprido sem prova (B8)** |
| RC-2 / ALT-3 | HD-AF-078 | Sem escalonamento efetivo; proposta em registro |
| RC-3 / DP-8 | HD-AF-078 | DoD por subtarefa como insumo, nunca gate |
| RC-4 | HD-AF-078 | Sem redução de gate; sem paralelismo |
| D22 (a) | v9 v6–v8, APPROVED 20/10 | §4.9: linhas 1–4 e 5a determinísticas; 5b em sombra |

Estado dos UNKNOWNs pela errata de 27/10: UNK-AR-004 **RESOLVED semanticamente**
(HD-AF-036) — o que segue aberto para o RC-1 é o **mecanismo** U10; UNK-AR-001
**PARTIALLY_RESOLVED** (HD-AF-074/077: o DOM-06 é dono do Context Record); UNK-AR-002 OPEN.

## Fora de escopo

Attempt `escalation`, `authorization_ref` e a escada como rota (S5b); piloto (S6); calibração
da 5b; seletor (S7d); paralelismo; IDs `Txx` (D19/PRI-132); edição do Roadmap e aplicação
dos RCs (PRI-293); restauração do workspace (UNK-AR-002); gatilho por p90 de tokens
(inativo); Dashboard das subtarefas; ligar a flag em qualquer consumidor real (ver "Portas
para ligar a flag").

## Comportamento

### B1. Flag e snapshot

- Chave nova `decomposition: "on" | "off"` em `.claude/model-routing.json` do consumidor.
  Ausente = `off`. É configuração, não policy (não muda o hash da policy).
- Com `mode` ausente/`OFF`, a chave é **ignorada**: `readRoutingConfig` continua devolvendo
  OFF, a admissão não muda, o check `routing-config` só emite **aviso**
  (`DECOMPOSITION_IGNORED_MODE_OFF`). Nada bloqueia um projeto OFF (RC-5).
- Com `mode = ON`: valor fora do enum → bloqueio de admissão do RC-5, como a S4, só no escopo ON.
- O valor entra no snapshot `routing` da admissão (imutável). O campo só é gravado quando o
  valor é `on`: ausente e `off` explícito deixam os **bytes** do snapshot iguais aos da S4.
  A Run nunca relê a config.
- **Reserva fail-closed:** em **todas** as fatias (S5.1, S5.2, S5.3) o valor `on` é recusado
  na admissão como reservado (`DECOMPOSITION_RESERVED`), igual à causa `escalation` na S4.
  Nenhuma Run real nasce decomposta antes das "Portas para ligar a flag", e nenhuma Run em
  voo é reinterpretada entre fatias. A reserva só sai por uma mudança própria (PR de
  liberação), depois que as portas forem cumpridas e registradas. Os testes ligam a
  decomposição injetando a admissão no harness (fixture), nunca pela config do consumidor.

### B2. Identidade e decomposição da visita (S5.2)

- Na primeira visita ao Implement de uma Run decomposta, o watcher calcula
  `extractPlanSteps` + `groupSteps` (código da S2, inalterado) e grava em `state.json`, pelo
  writer existente (`writeTaskState`, CAS):
  `decomposition = { plan_version, groups: [{ subtask_key, steps, paths_decl, initial_class, initial_resolution }], status, recorded_at }`.
- `status = NOT_DECOMPOSABLE` (o nó segue o caminho da S4, um Attempt, classe máxima;
  registrado, não bloqueia) quando: não há bloco de plano; ou **há grupos intercalados**
  (o intervalo `[min, max]` de um grupo contém passo de outro). Fundir grupos mudaria as
  `subtask_key` já usadas pelos sinais e pelo núcleo 2; recusar é o lado conservador.
- Passo sem `Arquivo:` parseável = grupo próprio, C4, `paths_decl = UNKNOWN`.
- k = 1 grupo: subtarefa + integração, sem atalho.
- Replan: nova `plan_version`, chaves anteriores em `decomposition.superseded[]`; nada é
  herdado por posição.
- `lineage_id = subtask_key`; todo Attempt depois do primeiro da chave tem `parent_attempt_id`.

### B3. Contrato do DOM-06 (escritor de Attempt)

Mudanças aditivas em `scripts/lib/dom06-attempt.js`; Attempt sem `role` se comporta como hoje.

- **Campos novos:** `role` (`subtask` | `integration` | `gate` | null), `subtask_key`,
  `plan_version`, `steps[]`, `parent_attempt_id`, `lineage_id`, `rework` (bool),
  `workspace = { baseline, post }` (B4: só digest, contagens, `completeness`),
  `context_record_sha256` (hash do bloco de contexto montado, Context Record imutável,
  HD-AF-074/077), `acceptance = { accepted, reason }`, `failure_class` (B7),
  `escalation_proposal` (B7).
- **Obrigações** (`obligationsFor(node, ctx)`): subtarefa
  `[{ id: "execute_subtask:<key>", kind: "subtask_execution" }]`; integração
  `[{ id: "integrate:<pv>", kind: "integration" }, { id: "execute_node", kind: "node_execution" }]`;
  demais casos inalterados.
- **Saída única:** `closeOnExit({ attemptFile, code, claim, manifestPost, currentPlanVersion })`
  no DOM-06, chamada pelos **dois** caminhos de saída (`releaseLease` em `--follow` e o
  wrapper `node-lease.js release` no modo destacado). Para Attempt sem `role`, delega ao
  `fulfillOnExit` atual sem mudança. O JSON do lease leva só `attempt_id`, `task` e o
  caminho do diretório de manifestos; **nunca** a chave nem caminhos do consumidor.
- **Aceite** (só então a obrigação é cumprida):

| Saída | Condição | Resultado |
| -- | -- | -- |
| exit 0 | `post` COMPLETE, `plan_version` vigente, claim intacto | **aceito**; obrigação cumprida (`post == baseline` também aceita, com `no_change: true`) |
| exit 0 | `post` UNKNOWN | não aceito; `blocked` |
| qualquer | `plan_version` superada ou claim perdido (resultado tardio, F9) | `acceptance.reason = PLAN_SUPERSEDED` ou `CLAIM_LOST`; obrigação **não** cumprida; com `post == baseline` COMPLETE só registra; com mutação ou UNKNOWN → `blocked` (o diff nunca é herdado) |
| qualquer | o comando gravou outro status (SPEC_CHANGE pendente, pedido de autorização, `blocked`) | não aceito; a Run segue **o caminho desse status** como hoje; nada de `CLAIM_LOST` |
| qualquer | `state.json` ausente | não aceito; `STATE_MISSING`; `blocked` |
| exit ≠ 0 | — | regra do manifesto (B4) |

- **Claim:** `releaseNode` continua booleano (chamadores e testes atuais intactos); função
  nova `releaseNodeWithReason` devolve o **motivo** (`RELEASED`, `STATUS_CHANGED`,
  `LEASE_REPLACED`, `SESSION_CONFLICT`, `STATE_MISSING`) e é a única usada por
  `closeOnExit`; `releaseNode` passa a delegar a ela e devolver `motivo === RELEASED`. **Claim perdido só com
  `SESSION_CONFLICT` ou `LEASE_REPLACED`** (outro `node_started_at`/`execution_id`).
  `STATUS_CHANGED` é caminho legítimo do comando, não perda de claim (`node-lease.js:125-127`).
- **Attempt `role = gate`** (Review, Test, Verify da Run decomposta): `closeOnExit` cumpre
  `execute_node` por exit 0 como hoje (via `fulfillOnExit`) e grava o `post`. `post` UNKNOWN
  não muda o veredito do gate; só bloqueia o Attempt seguinte pela cadeia (B4).
- **Agregação:** `aggregateImplement(runDir, planVersion, groups)` cumpre `execute_node` no
  Attempt de integração aceito, com chave `aggregate:<pv>`, só se **todas** as chaves da
  versão vigente (e o rework `ALL`, se houve, B5.6) têm o último Attempt aceito e
  `integrate:<pv>` está cumprida. É idempotente **na Run**: antes de gravar, procura
  `aggregate:<pv>` em todos os Attempts; achou, devolve o existente sem gravar.
- **Seleção do anterior:** `latestBound(runDir, node, { subtaskKey, role })`. Com
  `subtaskKey`, filtra pela chave; sem, ignora Attempts com `role` (retry da integração ou
  do Implement não decomposto nunca pega Attempt de passo). `retryAttempt` passa a chave e
  preenche `parent_attempt_id`.
- **Causa:** Attempt de subtarefa recebe a causa explícita do watcher (não `causeFromState`):
  `retry` só para nova tentativa da **mesma chave** depois de falha operacional; primeira
  tentativa de uma chave e rework de qualidade = `dispatch` com `rework: true` quando for rework.
- **Órfão** (STARTED sem saída, recovery existente `recoverOrphanedNodes`): compara o
  manifesto corrente com o `baseline` do órfão, fecha o órfão como `UNCERTAIN` e aplica a
  regra do manifesto. Nunca reaplica efeito de resultado incerto.
- `escalation` segue reservada (`assertCauseAllowed` inalterado).

### B4. Manifesto do workspace (§3.5)

Módulo novo `scripts/lib/workspace-manifest.js`, só leitura.

- **Componentes e comandos:** como a tabela do §3.5, com `GIT_OPTIONAL_LOCKS=0`; `git
  hash-object` sem `-w`; nada de stash, reset, checkout, add. Ignorados:
  `git ls-files --others --ignored --exclude-standard -z -- <pathspecs>` com pathspecs =
  **união dos `paths_decl` da `plan_version` vigente** + `workspace_watch_globs`; o limite
  conta depois do filtro.
- **Escopo único por `plan_version`:** a mesma união vale para todos os manifestos daquela
  versão do plano, para que manifestos de Attempts diferentes sejam comparáveis; no replan,
  ver a reancoragem `SCOPE_CHANGED`. Fora, declarado: `memory/runs/**` e
  ignorados fora da união. Mudança nesses não é observada (limite, não prova).
- **Chave e manifestos fora do worktree:** chave de 32 bytes em
  `REPO_PATH/memory/runs/_dom06-keys/<task>.key` (0600) e manifestos completos em
  `REPO_PATH/memory/runs/_dom06-manifests/<task>/<attempt_id>.{baseline,post}.json`, no
  checkout principal, diretório do orquestrador, fora do cwd do agente. Antes de criar,
  `git check-ignore` do caminho no checkout principal; não ignorado → `completeness =
  UNKNOWN` (`KEY_PATH_NOT_IGNORED`), nada é gravado. A chave é apagada quando a Run é
  arquivada; manifestos com caminhos não vão para o `_archive`. **Limite aceito:** "fora do
  cwd" não é "inacessível"; o agente tem Bash e pode ler caminho absoluto. A defesa é contra
  exportação (evidência, handoff, telemetria, `_archive`), não contra o próprio agente.
- **Identidade de entrada:** `HMAC-SHA256(key, componente \0 caminho \0 modo \0 blob_id)`.
- **O que vai no Attempt:** `digest` (SHA-256 da lista canônica ordenada de HMACs),
  contagens por componente e `completeness` com causa. Com `UNKNOWN`, contagens = `null`.
  Nunca caminho, blob id, hash simples, chave.
- **`UNKNOWN`** quando: comando git com erro (sem nova tentativa do comando); arquivo
  ilegível; link para fora do worktree; submódulo com mudança; limite excedido
  (`manifest_limits`; sem a seção, 20 000 entradas e 256 MiB); duas leituras seguidas com
  digest diferente; chave ausente ou ilegível; `KEY_PATH_NOT_IGNORED`.
- **Manifesto em todo Attempt da Run decomposta:** subtarefa, integração e, sob a flag, também
  Review, Test e Verify (`role = gate`), todos com `baseline` e `post`, só leitura. Isso
  estende a observação aos gates sem mudar o que eles fazem (**Q6**).
- **Encadeamento:** o `baseline` de todo Attempt da Run decomposta deve ser igual ao `post`
  do **Attempt manifestado imediatamente anterior da Run**, qualquer que seja o nó (v9 §3.5:
  "sem Attempt no meio"). Diferente, ou `post` anterior `UNKNOWN` → `blocked`.
- **Reancoragens** (as únicas; cada uma gravada no Attempt como `chain_anchor = { reason,
  by, at }`, nunca implícita):
  - `RUN_START`: primeiro Attempt manifestado da Run (o anterior é o Plan, sem manifesto).
    "Post anterior ausente" é início de cadeia, distinto de `UNKNOWN`.
  - `SCOPE_CHANGED`: replan com nova `plan_version`. O watcher recalcula o manifesto corrente
    no escopo **antigo**; igual ao último `post` → reancora no escopo novo; diferente ou
    UNKNOWN → `blocked`.
  - `HUMAN_UNBLOCK`: depois do desbloqueio humano pelo mecanismo existente (`unblocked`,
    `readmine-watcher.js:1233-1263`), o primeiro Attempt aceita o manifesto corrente como
    nova base, com `by` = o humano registrado em `unblocked`.
  - `HUMAN_RESUME`: retomada por ação humana depois de um status que **não** passou pela regra
    do manifesto (`STATUS_CHANGED` — SPEC_CHANGE ou autorização aprovada — ou `session_limit`
    retomado pelo dashboard). Se o `post` do Attempt interrompido difere do seu `baseline`
    (mutação parcial), o próximo Attempt da mesma chave só continua com `chain_anchor =
    { reason: HUMAN_RESUME, by }` da aprovação/retomada registrada; é **continuação
    autorizada** sobre trabalho parcial, declarada, não retry automático. Sem registro humano
    → `blocked`.
- **Falha operacional** (exit ≠ 0, timeout, erro de provider):

| Estado | Ação |
| -- | -- |
| `baseline` e atual COMPLETE e iguais | sem mutação: **um** retry automático da mesma chave, mesma resolução, causa `retry`, `parent_attempt_id`; segunda falha da mesma chave → `blocked`. Indisponibilidade do provider (`looksUnavailable`) **não conta** no teto e segue redespachada como no controle (D15) |
| ambos COMPLETE e diferentes | mutação parcial: sem retry; `blocked`; contagem de entradas alteradas no aviso, caminhos só no arquivo local; diff preservado |
| qualquer `UNKNOWN` | mutação possível: sem retry; `blocked` |

- **Writer do `blocked`:** o watcher, pelo mesmo caminho da recusa de roteamento da S4
  (`writeTaskState` com CAS + `notifyBlocked`, uma vez por assinatura). No modo destacado,
  `closeOnExit` grava só o Attempt; o `blocked` é aplicado pelo watcher no tick seguinte, a
  partir do `acceptance` gravado. **Precedência:** `session_limit` (writer existente,
  `readmine-watcher.js:4940-4951`) prevalece e não conta no teto; o `blocked` do manifesto
  nunca sobrescreve `session_limit` nem um status gravado pelo comando.
- O manifesto não resolve UNK-AR-002 nem escolhe restauração.

### B5. Sequenciamento no watcher (S5.2, atrás da flag)

Só no nó `implement` de Run com `decomposition = on` e `status` decomponível.

1. **Portões por visita × por Attempt:**

| Portão | Hoje | Na Run decomposta |
| -- | -- | -- |
| pré-build (`needsPreBuildGate`) | enquanto `history` não tem `implement` | **uma vez**, antes da primeira subtarefa da primeira visita (critério: não existe Attempt `role = subtask` na Run) |
| churn (`needsChurnGate`/`recordRound`) | a cada despacho do implement | **uma vez por visita**, antes da primeira subtarefa da visita |
| spec-drift, `human-input` | a cada despacho | a cada Attempt (o input vai para o Attempt que o consumiu) |
| segmentos `--follow` (`MAX_FOLLOW_SEGMENTS=30`) | por Run | inalterado; estourar o limite pára como hoje (risco declarado) |

2. Escolhe a próxima chave pendente na ordem do menor passo (sem intercalação, B2).
3. **Resolução:** `resolveRoute` com os sinais **só do grupo** e `subtaskKey`. Precedência:
   override humano vigente (subtarefa > nó > ticket, §4.7) **prevalece** sobre tudo; sem
   override, rework fica em `max(resolução inicial da linhagem, reclassificação)` e nunca abaixo.
4. `prepareDispatch` com `role`, `subtask_key`, causa explícita (B3); manifesto `baseline`;
   bloco de contexto (B6) com `context_record_sha256`; despacho `/implement-step <task> <key>`.
5. Saída: `closeOnExit` (B3). O comando de passo não muda `state.node`, `history`, `retries`
   nem `agent_log` de nó; o próximo tick pega a próxima chave.
6. Todas aceitas → integração, rota `default_route` (nó fixo, Q4), `/implement-integrate
   <task>`. O comando **não** faz `transition`. Na saída aceita, o watcher chama
   `aggregateImplement`; com `execute_node` cumprida, o **watcher** faz a transição
   implement → review pelo writer existente (`state-writer transition`, CAS) e acrescenta
   `implement` ao `history`. Defesa: o despacho da Review numa Run decomposta exige
   `aggregate:<pv vigente>` gravado; sem ele, `blocked`.
7. **Volta de gate** (Review ou Test, `on_fail: implement`): o watcher calcula
   `failure_class` (B7) e mapeia os achados por arquivo (arquivo em `paths_decl` de
   exatamente um grupo). Cada chave mapeada ganha um rework; depois, nova integração.
   Achado sem mapeamento inequívoco → um rework do nó inteiro com chave sintética
   `<pv12>/ALL` (`role = subtask`, fora da identidade D14: não tem resolução inicial
   própria, não aceita override de subtarefa, só de nó/ticket, entra na agregação da
   visita). Resolução (Q7 a): **C4** (T3), `selection_source = RISK_RECLASSIFIED`, como o
   v9 §3.4 ("nó inteiro em C4").
8. Arquivo fora de `paths_decl` no `post` de uma subtarefa: `scope_violation` no Attempt
   (não invalida, HD-AF-034). Próximo Attempt da linhagem (Q7 a): **≥ C4**,
   `selection_source = RISK_RECLASSIFIED` (v9 §4.6 e §4.9 linha 4). É reclassificação de
   risco, **não** `escalation`: não cria Attempt `escalation`, não gera proposta, não usa
   `authorization_ref` e é contada à parte nas métricas (m3).
9. **Sem a S5.3 entregue:** `failure_class = null`, rework na mesma resolução, sem proposta,
   `scope_violation` só registrado (sem reclassificação). A liberação da flag exige a S5.3
   entregue ou dispensada (Portas).

### B6. Comandos de passo e de integração (S5.2)

- `.claude/commands/implement-step.md` (novo): só os passos do grupo; escopo de escrita =
  `paths_decl`; não roda `/review` nem `/plan`; não muda `node`, `history`, `retries`,
  `agent_log` de nó; registra o resultado num bloco
  `<!-- subtask:<key>:inicio -->…<!-- subtask:<key>:fim -->` do `handoff.md`. Reusa as regras
  do `/implement` (spec viva, SPEC_CHANGE, TECHNICAL_DECISION) **por referência**.
- `.claude/commands/implement-integrate.md` (novo): autoverificação e ajustes de junção; regras
  dos passos 4–7 do `/implement` por referência, **sem** `transition`; preserva os blocos
  `subtask:*` do `handoff.md`; termina sem rodar `/review` (a Review é despachada pelo watcher).
- **Desvio declarado do v9 §3.4** (que manda rodar "o comando de Implement atual em modo de
  verificação"): comando separado, para que `implement.md` fique byte a byte igual e o golden
  do caminho OFF valha. O comportamento pedido pelo v9 é o mesmo.
- **Bloco de contexto (UNK-AR-001, parcial):** montado pelo watcher (como `nodeContextBlock`):
  `subtask_key`, texto dos passos, `paths_decl`, ACs do grupo, DoD. O hash do bloco vai no
  Attempt como Context Record (DOM-06 dono, HD-AF-074/077).
- **DoD por subtarefa (DP-8, insumo):** ACs do grupo (`coverage.<AC>.plan_steps` ∩ passos),
  linhas `Verificação:` dos passos e "manifesto `post` COMPLETE, sem arquivo fora de
  `paths_decl`". Vai no prompt e no Attempt (`dod = { items[], source: "derived",
  self_reported_status }`). **Não é gate.**

### B7. `failure_class`, proposta (S5.3)

- **Produtor e dono:** o watcher calcula na entrada da visita de rework, a partir dos
  artefatos existentes (`review_results`, resultado do Test, `acceptance-evidence.json` quando
  houver, pré-build registrado, `scope_violation` dos Attempts). O DOM-06 grava o resultado,
  imutável, **no Attempt de rework, na criação**: `failure_class = { class, line, signals[] }`,
  sinais só como códigos (sem caminho). Nenhum arquivo novo.
- **Classificador** `scripts/lib/failure-class.js` (puro), ordem 1 → 2 → 3 → 4 → 5a → 5b:
  1. `operacional`: exit ≠ 0, timeout, erro de provider;
  2. `ambiente`: padrão de infraestrutura (lista fechada: conexão recusada, dependência
     ausente, build quebrado antes do diff);
  3. `plano_ou_spec`: `PLAN_OMITS_AC`, `PLAN_UNKNOWN_AC`, `SPEC_CHANGE`,
     `SPEC_CHANGE_MID_RUN`, spec-drift (quando a Run volta ao Implement com esses códigos
     registrados; o Verify volta ao Test, não ao Implement, `graph.yaml:90`);
  4. `escopo`: `scope_violation`;
  5a. `capacidade`: (i) compilação/typecheck com erro em arquivo de `paths_decl` **e** base
     compilando segundo o **pré-build** registrado; (ii) assertion em teste de `paths_decl` ou
     ligado a AC do passo **que não existia na base** (via git); (iii) `AC_EVIDENCE_FAIL` de AC
     com `coverage.<AC>.plan_steps` **só** no grupo e evidência `automated-test`,
     `regression-test` ou `integration-test`. `AC_BLOCKED`, `AC_STATUS_INCONSISTENT` nunca;
  5b. `revisao_julgada`: só a Review reprova, achado mapeado.
  - **Desvios declarados do v9:** a "base" da 5a(i) é a do pré-build (estado antes do
    primeiro Implement), não o `workspace.baseline` do Attempt; não há execução de teste na
    base, então "passava na base" (5a(ii)) e "mesmo teste falha na base" (linha 2) não têm
    evidência e **não casam** — só o padrão da linha 2 e o "não existia" da 5a(ii) contam.
  - Evidência ausente, pré-build `UNKNOWN` ou `paths_decl = UNKNOWN` → a linha não casa.
    Nada vira `capacidade` por ausência.
- **Review:** `review-result.js record` aceita, por achado, `failure_class_suggestion`
  opcional (enum `capacidade | plano_ou_spec | ambiente | revisao_julgada`) em
  `review_results`, como sombra. Sem efeito em rota, classe, argv. Achado sem o campo é válido.
- **Efeito:** 1 → B4; 2, 3 → caminho atual; 4 → `RISK_RECLASSIFIED` ≥ C4 (Q7 a); 5a → proposta + rework na mesma
  resolução; 5b → rework na mesma resolução, sem proposta.
- **Proposta** (`escalation_proposal`), gravada no **Attempt de rework, na criação**, ligada
  por `parent_attempt_id`: campos de `validateEscalationProposal` (`node`, `subtask_key`,
  `failure_class`, `from`, `to`, `proposed_at`, `authorization_ref = null`) + `status =
  SHADOW_NOT_AUTHORIZED`, `evidence_5a` (códigos da 5a), `effort_applied` (U1). `from` =
  resolução inicial; `to` = `default_route` (T3, alto). Só quando `to` é **estritamente mais
  forte** que `from` na ordem parcial do §4.6 (não reduz tier nem esforço e aumenta ao menos
  um); igual ou incomparável (ex.: override (T2, máximo)) → sem proposta, `would_escalate =
  false`, `NO_STRONGER_DESTINATION`. Com `effort_applied = false`, a proposta registra que o
  modelo efetivo pode ser o mesmo. Uma por subtarefa; a segunda → `proposal_suppressed =
  ALREADY_PROPOSED`. A RoutingDecision do rework grava `escalation_mode = "SHADOW"` e `would_escalate`.
- Nenhum caminho do escritor transforma a proposta em despacho.

### B8. Subagentes (RC-1 / DP-4a) — gate da S5

- Subagente é uso **dentro** do Attempt, por papel; não vira Attempt.
- RoutingDecision de subtarefa e integração grava `subagent_roles[] = { role,
  declared_model, observed_model, enforcement }`; `observed_model` vem da trilha de uso por
  Attempt da S1, depois da saída.
- O mapa papel → modelo exige seção nova na policy (`subagent_roles`) → **nova versão de
  policy aprovada pelo Richard**.
- **Gate:** a HD diz "gate só na S5". `enforcement = ENFORCED` só com o mecanismo U10
  verificado (tarefa 0 da S5.2; candidato a verificar: declarar os papéis no despacho com o
  modelo da policy). **Sem prova, o gate do RC-1 fica NÃO CUMPRIDO**: o código grava
  `UNENFORCED` e `SUBAGENT_MODEL_MISMATCH` observado (sem invalidar Attempt), mas a flag não
  pode ser ligada em Run real até o Richard decidir (Q2). `UNENFORCED` nunca é o desfecho
  aprovado por omissão.

### B9. Métrica de melhoria do Implement (RC-3; proposta, sem limiar)

| Métrica | Fonte e cálculo | Baseline S1–S3 | Direção de "melhor" |
| -- | -- | -- | -- |
| m1 aprovação da Review na 1ª rodada sobre o integrado | `review_results.history[0].verdict` por Run | sim (todo Run tem Review) | maior |
| m2 voltas Review/Test → Implement | rodadas em `review_results.history` + eventos de transição para `implement` (não `retries`, zerados no desbloqueio) | sim | menor |
| m3 distribuição de `failure_class` | Attempts de rework | **não** (classe nasce aqui) | menos `capacidade`/`revisao_julgada` em classes rebaixadas |
| m4 reworks por subtarefa | Attempts `rework: true` por chave | **não** | menor |
| m5 custo da unidade (indicador, D7) | trilha de custo da S1 | parcial (23 de 136 Runs, PRI-191) | menor, só como indicador |

Comparador: o braço A0m da S6 (D15), não a baseline histórica. Ausente = `null`, nunca 0
(UNK-AR-006). Nenhum limiar aqui; a regra de decisão é a D8, fechada antes de medir.
Sem aprovação do Richard, "melhorou" segue UNKNOWN.

## Portas para ligar a flag (nenhuma é dada por esta SDD)

A reserva `DECOMPOSITION_RESERVED` (B1) fica no código até um PR de liberação próprio, que
só pode ser aberto com: (1) gate do RC-1 cumprido ou dispensado pelo Richard (Q2); (2)
HD-AF-078 como base de liberação (D-6, decidida em 27/10; a PRI-293 não é pré-condição) e a
nota da Q7 entregue à reconciliação; (3) nova versão de policy com as
seções novas, aprovada; (4) Q6 e Q7 decididas (ambas decididas em 2026-11-09); (5) S5.3 entregue ou dispensada por decisão.
Cada porta é citada no PR de liberação por referência verificável (comentário/decisão).

## Critérios de aceite (definitivos propostos)

**S5.1: flag, contrato e manifesto (testes unitários e de integração do DOM-06)**
- AC-01 Golden novo gerado em `2024597`, antes de qualquer mudança: Run `mode ON` sem a chave
  e com `off`, e Run `{ mode: OFF, decomposition: on }`; compara argv, env, snapshot
  (bytes), Attempts (sem ids/horários), obrigações e transições. Depois das mudanças, idêntico.
- AC-02 `mode` OFF/ausente + `decomposition` qualquer: admissão inalterada, só aviso no check.
  `mode ON` + valor fora do enum: bloqueio do RC-5 sem criar Run.
- AC-03 Em todas as fatias: `mode ON` + `on` pela config → recusa `DECOMPOSITION_RESERVED`,
  sem Run; `off` explícito → snapshot byte a byte igual ao de flag ausente.
- AC-04 Identidade: mesma entrada → mesmas chaves; replan → `SUPERSEDED`; passo sem `Arquivo:`
  → grupo C4; grupos intercalados → `NOT_DECOMPOSABLE`.
- AC-05 Aceite: a tabela de B3 linha a linha; exit 0 com `post` UNKNOWN não cumpre
  obrigação; `summarize` só dá PASS com aceite.
- AC-06 `aggregateImplement`: falta uma chave → nada gravado e pendentes devolvidas; duas
  integrações aceitas → `execute_node` cumprida uma vez na Run.
- AC-07 `latestBound` com intercalação A → B → A(retry) → integração: retry de B nunca pega A
  nem a integração; retry da integração nunca pega subtarefa.
- AC-08 Resultado tardio: sem mutação só registra; com mutação → `acceptance` não aceito e
  sinal de `blocked`.
- AC-09 `closeOnExit` dá o mesmo resultado chamado pelo caminho `--follow` e pelo wrapper
  `node-lease.js release`; `SESSION_CONFLICT`/`LEASE_REPLACED` → `CLAIM_LOST`; comando que
  gravou SPEC_CHANGE pendente (`STATUS_CHANGED`) → segue o caminho do status, sem `CLAIM_LOST`
  nem `blocked`; chamadores atuais de `releaseNode` com o mesmo comportamento; gate com exit 0
  cumpre `execute_node` e grava `post`.
- AC-10 Órfão: fechado `UNCERTAIN`, manifesto corrente comparado ao `baseline`.
- AC-11 Nenhum Attempt com causa `escalation` (teste da S4 continua passando).
- Manifesto, repositórios git sintéticos:
  - AC-12 M1: untracked muda A → B → diferentes.
  - AC-13 M2: só o modo → diferentes.
  - AC-14 M3: só o índice → diferentes.
  - AC-15 M4: `.env` em `workspace_watch_globs` (policy de fixture) muda → diferentes;
    `node_modules/` muda → iguais, limite declarado; `node_modules/` com 50 000 arquivos não
    estoura o limite (pathspec).
  - AC-16 M5: comando git com erro → `UNKNOWN`, sem nova tentativa.
  - AC-17 M6: nenhuma escrita no repo (índice, objetos, refs idênticos; nenhum objeto novo).
  - AC-18 M7: Attempt, handoff, evidência, `_archive` e transcript simulado não contêm
    caminho, blob id, hash simples ou a chave; chave fora do worktree; caminho da chave não
    ignorado → `KEY_PATH_NOT_IGNORED`.
  - AC-19 M8: encadeamento A → B → integração → gate (Test escreve teste) → rework de A:
    `baseline` de cada um igual ao `post` do imediatamente anterior → segue; mudança fora de
    Attempt → `blocked`; reancoragens `RUN_START` (primeira subtarefa, sem `blocked`),
    `SCOPE_CHANGED` (replan com e sem mudança no escopo antigo) e `HUMAN_UNBLOCK`
    (desbloqueio com worktree editado) e `HUMAN_RESUME` (SPEC_CHANGE aprovada e
    `session_limit` retomado, ambos com mutação parcial) gravadas com `chain_anchor`.
  - AC-20 M9: falha sem mutação → um retry; segunda falha da mesma chave → `blocked`;
    com mutação → `blocked` sem reset; indisponibilidade não conta no teto;
    `session_limit` prevalece sobre o `blocked`.
  - AC-21 Extras de `UNKNOWN`: link para fora, arquivo alterado entre leituras, limite,
    chave ausente; contagens `null`.

**S5.2: watcher, comandos, gates, subagentes**
- AC-22 Run decomposta: subtarefas em ordem, uma por vez, `/implement-step`; nenhuma Review
  antes da agregação; transição implement → review feita pelo watcher só com `aggregate:<pv>`;
  Review sem agregação → `blocked`. Review, Test, Verify uma vez sobre o integrado.
- AC-23 Pré-build uma vez antes da primeira subtarefa; churn uma vez por visita.
- AC-24 Classe por grupo; override humano prevalece; sem override, rework ≥ resolução inicial.
- AC-25 Achado mapeado → rework só da chave; sem mapeamento → rework `ALL` em C4 com `RISK_RECLASSIFIED` (Q7 a); `scope_violation` → próximo Attempt da linhagem ≥ C4 com `RISK_RECLASSIFIED`, sem proposta nem Attempt `escalation`.
- AC-26 Modo destacado (sem `--follow`): ciclo completo de duas subtarefas + integração.
- AC-27 `subagent_roles[]` gravado; sem U10 provado, `UNENFORCED` e o gate RC-1 marcado não
  cumprido na evidência.
- AC-28 DoD derivado e gravado; não aprova nem reprova nada.
- AC-29 `implement.md` byte a byte igual ao de `2024597`.

**S5.3: `failure_class` e proposta**
- AC-30 Casos do §4.9: compilação em `paths_decl` com pré-build OK → 5a; pré-build falho →
  não 5a(i); pré-build UNKNOWN → não 5a(i); assertion em teste novo → 5a; conexão recusada
  → 2; `PLAN_OMITS_AC` → 3; fora de `paths_decl` → 4; só Review → 5b, mesma resolução, sem
  proposta; `AC_EVIDENCE_FAIL` só do grupo com cada um dos três enums → 5a(iii); AC em dois
  grupos → não 5a; `AC_BLOCKED` → não `capacidade`; `paths_decl = UNKNOWN` → nem 4 nem 5a.
- AC-31 `capacidade` → proposta válida no Attempt de rework (`SHADOW_NOT_AUTHORIZED`,
  `authorization_ref = null`, `effort_applied`) e rework na mesma resolução, sem Attempt
  `escalation`; segunda vez → `ALREADY_PROPOSED`.
- AC-32 As 10 células (C1–C5 × P1/P1e): C1, C2 → `to = (T3, alto)`; C3, C4, C5 → sem
  proposta, C5 mantém o máximo; override incomparável → `NO_STRONGER_DESTINATION`; nenhuma
  resolução abaixo da inicial.
- AC-33 `failure_class_suggestion` gravada, sem efeito em rota, classe ou argv.
- AC-34 `failure_class` gravado só como códigos, imutável no Attempt de rework.

**Todas:** AC-35 suítes `scripts/` e `dashboard/` passam pela receita oficial (Node 22 e 24).

## Arquivos previstos

S5.1: `scripts/lib/dom06-attempt.js`, `scripts/lib/workspace-manifest.js` (novo),
`scripts/lib/node-lease.js` (chamar `closeOnExit`), `scripts/lib/model-routing-policy.js` e
`config-validator.js` (chave `decomposition`; seções opcionais de policy),
`scripts/lib/routing-run.js`/`model-routing.js` (snapshot), golden novo, testes.
S5.2: `scripts/readmine-watcher.js` (ramo `implement` decomposto, portões, transição,
defesa da Review), `scripts/lib/plan-signals.js` (detecção de intercalação, sem mudar
`groupSteps`), `scripts/lib/model-routing.js` (classe por grupo, `subagent_roles`),
`.claude/commands/implement-step.md` e `implement-integrate.md` (novos),
`.graph/schemas/state.schema.json` (`decomposition`), `ownership.yaml` e
`docs/concurrency-map.md` (transição implement → review pelo watcher na Run decomposta), testes.
S5.3: `scripts/lib/failure-class.js` (novo), `scripts/lib/review-result.js`,
`.claude/commands/review.md` (campo opcional), `dom06-attempt.js` (proposta), testes.

## Estimativa e divisão

**Estimativa: 13 pontos (faixa 11 a 16).** Base: a S4 (5 pontos) precisou de dois PRs de
correção (#99, #100) só no despacho; aqui há mudança de contrato do DOM-06, dois caminhos de
saída, um módulo de git com mais de 9 casos, dois comandos, a transição movida para o
watcher, portões por visita e um classificador. Sem base empírica para contrato do escritor.

A regra da issue manda dividir acima de 5. A divisão pedida (contrato + manifesto; comando
de passo + `failure_class`) deixa a segunda parte com 8. Proposta: três filhas da PRI-287,
PR em draft cada, sequenciais:

| Fatia | Conteúdo | ACs | Pontos |
| -- | -- | -- | -- |
| **S5.1 contrato + manifesto** | B1, B3, B4; `on` reservado; nenhum despacho novo | AC-01 a AC-21 | 5 |
| **S5.2 comando de passo** | B2, B5, B6, B8 (com a tarefa 0 do U10) | AC-22 a AC-29 | 5 |
| **S5.3 `failure_class` + proposta** | B7, B9 | AC-30 a AC-34 | 3 |

Se preferir só duas, a S5.3 entra na S5.2 (8 pontos). Nomes S5.n para não colidir com a S5b.

## Perguntas para o Richard

| ID | Pergunta | Opções | Recomendação |
| -- | -- | -- | -- |
| Q1 | Divisão | (a) S5.1 + S5.2 + S5.3; (b) S5.1 + S5.2 (com `failure_class`, 8 pts) | **(a)** |
| Q2 | Gate do RC-1 com U10 nunca verificado | (a) tarefa 0 da S5.2 verifica um mecanismo; sem prova, gate não cumprido e a flag não liga até nova decisão sua; (b) você dispensa o gate por decisão registrada e aceita `UNENFORCED` até antes da S6; (c) proibir subagentes nos Attempts de passo | **(a)**. (c) faz os braços diferirem do controle fora da intervenção (D15) |
| Q3 | Implementar antes da PRI-293 (RC-1, RC-3 NOT APPLIED) | (a) implementar atrás da flag, sem alegar RC aplicado, com decisão governada registrada nesta issue; ligar a flag continua esperando a PRI-293; (b) esperar a PRI-293 | **CORRIGIDA (2026-11-09):** a pergunta partiu de premissa errada. A D-6 já foi **decidida** pelo Richard em 27/10 ("basta a HD-AF-078 para liberar as fatias S4 em diante; a PRI-293 não é pré-condição delas"); a v2.1 citou a recomendação anterior do Arquiteto (`plano-aplicacao-rcs.md`). A implementação segue atrás da flag, sem alegar RC aplicado; a PRI-293 fecha os RCs formalmente em paralelo |
| Q4 | Rota da integração | (a) `default_route` (T3, alto); (b) classe máxima dos grupos | **(a)** |
| Q5 | Métrica do RC-3 (B9) | aprovar m1–m5 como registro, sem limiar / ajustar | aprovar como registro |
| Q6 | Manifesto (só leitura) também nos Attempts de Review/Test/Verify da Run decomposta | (a) sim, sob a flag; (b) não, e o rework depois de gate parte do `post` do gate sem prova (o encadeamento fica quebrado e todo rework vai para `blocked`) | **(a)**: única forma de cumprir o "sem Attempt no meio" do v9 §3.5 |
| Q7 | Resolução depois de `scope_violation` e no rework `ALL` (sem mapeamento) para grupos C1/C2 | (a) reclassificação de **risco** do v9 §4.6 e §4.9 linha 4 (não alterada pela HD): sobe a ≥ C4 com `selection_source = RISK_RECLASSIFIED`, não é `escalation`, medida nas métricas; tensiona o texto da HD ("subida de tier nunca automática por falha"); (b) mesma resolução (`ALL` = maior resolução inicial dos grupos), **sem proposta** (a HD limita a proposta à `capacidade`); diverge do v9 §3.4/§4.6 ("nó inteiro em C4", "≥ C4") e exige registro governado (delta D-8 ou reconciliação, regra 8) | **DECIDIDA: (a)** (Richard, 2026-11-09). Leitura registrada: reclassificação por escopo/sem mapeamento é **risco**, não "subida por falha" da HD-AF-078; a tensão com o texto da HD vai como nota para a reconciliação (PRI-293) |

## Premissas (valem se você não corrigir)

- P-1 Passos continuam numerados; `Txx` fica com a PRI-132.
- P-2 Integração no `default_route` (Q4 a).
- P-3 k = 1 também passa por subtarefa + integração.
- P-4 Um retry automático por chave sem mutação; teto de voltas de gate inalterado (`graph.yaml`).
- P-5 Sem `manifest_limits`: 20 000 entradas e 256 MiB.
- P-6 `WATCHER_QA_DIAGNOSTICO` e o polling não são tocados; testes loopback-only.

## Riscos e UNKNOWNs

- Muda o contrato do escritor e move a transição implement → review para o watcher na Run
  decomposta: risco de regressão contido pelo golden (AC-01) e por `role` ausente = AS-IS.
- Overhead de k despachos com cache frio (U3) e `MAX_FOLLOW_SEGMENTS` com k alto: medidos na S6.
- UNK-AR-002 OPEN: regra conservadora gera mais `blocked` em falhas com mutação.
- UNK-AR-001 parcial: o watcher monta o bloco; o DOM-06 guarda o hash; o dono formal do
  conteúdo fica com a reconciliação.
- U10 UNKNOWN: sem prova, gate RC-1 não cumprido (B8).
- 5b sem efeito antes da calibração: subtarefa rebaixada pode repetir a falha, limitada pelos tetos.
- `effort_applied = false` em produção: no braço P1e, proposta e origem podem ter o mesmo modelo efetivo.

## Disposição dos achados da G3 (rodada 1)

| Achado | Disposição |
| -- | -- |
| O-01 / A-01 (BLOCKER) | B4: manifesto em todo Attempt da Run decomposta, encadeado ao imediatamente anterior; escopo de ignorados único (união); Q6; AC-19 |
| O-02 / A-14 | Contexto e B4: Run fica no worktree; chave e manifestos em `REPO_PATH/memory/runs/_dom06-*`, `check-ignore`; AC-18 |
| O-03 | B4: um retry por chave, writer do `blocked` definido, sem `retries.implement`; P-4 |
| O-04 / A-03 | B3: `closeOnExit` nos dois caminhos; `node-lease.js`; claim = retorno de `releaseNode`; AC-09, AC-26 |
| O-05 | B3: tabela de aceite; obrigação só com aceite; AC-05 |
| O-06 / A-02 | B3: resultado tardio com mutação → `blocked`; AC-08 |
| O-07 | B5.6: comando de integração sem `transition`; watcher transiciona após agregação; defesa na Review; AC-22 |
| O-08 | B2: grupos intercalados → `NOT_DECOMPOSABLE`; AC-04 |
| O-09 / A-09 | B1: `mode` OFF ignora a chave, só aviso; seções novas exigem nova policy |
| O-10 / A-06 | B8 e "Portas": gate do RC-1 não cumprido sem prova; Q2 reescrita |
| O-11 | B1: `on` reservado na S5.1; B2 movido para a S5.2; ACs da S5.1 unitários |
| O-12 | AC-01: golden novo de Run ON com Attempts, obrigações e transições |
| O-13 / A-04 | B5.1: portões por visita × por Attempt; AC-23 |
| O-14 | B4: pathspec, NUL no HMAC, contagens `null` |
| O-15 | B7: desvios declarados (pré-build, sem teste na base, Verify volta ao Test, `paths_decl` UNKNOWN) |
| O-16 / A-08 | B7: proposta no Attempt de rework, campos completos, ordem parcial, `effort_applied` |
| O-17 / A-11 | B6: desvio do v9 declarado; preservação dos blocos; limites do comando de passo |
| O-18 | B5.3: override humano prevalece |
| O-19 | B3: agregação idempotente na Run; órfão `UNCERTAIN` |
| O-20 / A-12 | Estimativa 13 (11–16); três fatias |
| O-21 | Q3 reescrita |
| A-05 | B5.7–8 e Q7; chave `ALL` definida |
| A-07 | B7: produtor (watcher) e dono (DOM-06, Attempt de rework) |
| A-10 | Decisões e UNKNOWNs pela errata; D-9 com proveniência; Context Record; fontes citam a HD |
| A-13 | B9: tabela com fonte, baseline, direção, comparador, `null` |
| A-15 | B3: causa explícita do watcher para subtarefas |

## Disposição dos achados da G3 (rodada 2)

| Achado | Disposição |
| -- | -- |
| R2-O-01 (MAJOR) / R2-A-02 (b) | B4: reancoragens `RUN_START`, `SCOPE_CHANGED`, `HUMAN_UNBLOCK` com `chain_anchor`; escopo por `plan_version`; AC-19 |
| R2-O-02 (MAJOR) | B3: `releaseNode` devolve motivo; claim perdido só com `SESSION_CONFLICT`/`LEASE_REPLACED`; `STATUS_CHANGED` segue o caminho do status; AC-09 |
| R2-O-03 / R2-A-02 (c) | B3: semântica de saída do `role = gate` |
| R2-A-02 (a) | B4: gates gravam `baseline` e `post` |
| R2-O-04 | B1: campo só com `on`; AC-03 |
| R2-A-01 (MAJOR) / R2-O-05 | B1: reserva fail-closed em todas as fatias; liberação por PR próprio; Portas com 5 condições |
| R2-A-04 / R2-O-05 | B5.9: comportamento da S5.2 sem a S5.3 |
| R2-O-06 | B4: indisponibilidade fora do teto; precedência de `session_limit`; AC-20 |
| R2-A-03 / nota Q7 do Opus | Q7 reformulada: (b) sem proposta; as duas opções declaram de que texto divergem |
| R2-A-05 | `docs/concurrency-map.md` e `ownership.yaml` nos arquivos da S5.2 |
| R2-O-02 resíduo do O-02 | B4: limite aceito (chave acessível ao agente por Bash) |
| R2-O-07 | Citação do wrapper corrigida; m2 sem `retries` |
| R2-A-10 NIT (D-9) | Registrada no comentário da issue com a frase do Richard |

## Disposição da conferência r3 (Opus: APPROVED_WITH_CHANGES, sem nova rodada)

| Achado | Disposição |
| -- | -- |
| R3-O-01 | B4: reancoragem `HUMAN_RESUME` (continuação autorizada e registrada sobre mutação parcial); AC-19 |
| R3-O-02 | B3: `releaseNode` continua booleano; `releaseNodeWithReason` nova |
| R3-O-03 | Não procede: a frase da reserva está completa (SPEC:102-103) |
