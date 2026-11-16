# Cobertura das obrigações O1–O21 / P1–P7 por teste executado

Issue: [PRI-365](https://linear.app/prisma-app/issue/PRI-365) (F3 da [PRI-363](https://linear.app/prisma-app/issue/PRI-363)). Cobre U-23, U-24, U-25 e U-05 do desenho da PRI-363.
Retrato de 15/11/2026 na SHA `7da4e970b3d5ce821b773d22cea4cb4f694435f9` (`main`). Não certifica READY nem cobertura universal.

## Fonte das obrigações

- Definição integral: F25 Approved (documento Linear `83f567a9-50ab-4c31-800c-9cc19d87dc91`, §5.1 e §5.2).
- Síntese no Git: [validation-map.md](validation-map.md), linhas 6–18.

## Método

- Receita oficial (`docs/runbook.md`, «Testes dos pacotes»): `harness/run-tests.js` com `env -i`, HOME/TMPDIR sintéticos e `loopback-only.cjs`.
- Um teste só conta se estiver no manifesto `test` do pacote e passar na rodada citada. Arquivo existir não conta. Arquivos fora do manifesto (`.claude/hooks/*.test.mjs`, `dashboard/agent-log-api.test.js`, probes) não contam.
- Para cada candidato, o corpo do teste foi lido e o título conferido no TAP.
- **PARCIAL** = há teste executado e verde que prova uma faceta nomeada; o resto da definição F25 fica `UNKNOWN`. Nenhuma obrigação está marcada como coberta por inteiro: os testes são locais e sintéticos, e a F25 pede evidência por subject, canal ou caminho.
- **UNKNOWN** = nenhum teste executado prova o núcleo da obrigação. A coluna «Falta» diz o que seria preciso.
- Nenhum N, limiar ou KPI de produto foi escolhido aqui.

## Rodadas

Todas na SHA `7da4e97`, macOS, dependências por `npm ci`. N declarado antes de ver o resultado completo da `run1`: 3 rodadas completas em Node 20.20.2 e 1 em Node 22.23.2. N é do procedimento desta investigação, não critério de aceite. A `run1` rodou com a árvore limpa. Nas demais, a única diferença possível era este doc não rastreado e o nome da branch do PR, no mesmo commit.

| Rodada | Node | `scripts/` (testes / pass / fail / skip) | `dashboard/` | SHA-256 do TAP `scripts` |
| -- | -- | -- | -- | -- |
| run1 | 20.20.2 | 2115 / 2105 / 4 / 6 | 552 / 552 | `a46f1734552481f6…` |
| run2 | 20.20.2 | 2115 / 2105 / 4 / 6 | 552 / 552 | `735347430da50ec3…` |
| run3 | 20.20.2 | 2115 / 2106 / 3 / 6 | 552 / 552 | `397bef51f5ecbe5d…` |
| run-node22 | 22.23.2 | 2115 / 2109 / 0 / 6 | 552 / 552 | `fdfe6ea064675c2e…` |
| CI `43741913850`, Linux | 22 e 24 | 2115 / 2109 / 0 / 6 (nas duas) | 552 / 552 | `fd5a84a400884a91…` (22), `274c1fc16f77d5e2…` (24) |

Recorte extra, fora do N: os 4 arquivos das falhas da PRI-359 com TMPDIR em `/var/folders` (Node 20.20.2), 61 testes, 59 pass, 2 fail.

Os 6 skips são os mesmos no local e no CI: `pdftotext` ausente (1), Docker com `postgres:16-alpine` ausente (4) e template fora do checkout (1). TAPs, hashes completos e a declaração de N estão em `~/Workspace/prisma-evidence/2026-11-15-pri-365/`.

## Tabela

Resultado: **22 PARCIAL, 6 UNKNOWN, 0 cobertas por inteiro.** Os testes citados neste doc estão entre os 80 títulos conferidos no TAP por título exato (nos gerados em laço, por amostra). Todos passam na rodada local `run1` (Node 20.20.2) e nas duas pernas do CI `43741913850` (Node 22 e 24), na mesma SHA. Caminhos relativos à raiz do repositório.

| ID | Estado | Teste executado (arquivo:linha) | Faceta provada | Falta (fica `UNKNOWN`) |
| -- | -- | -- | -- | -- |
| O1 | PARCIAL | `scripts/state-concurrency.test.js:499`, `:89`; `scripts/lib/sdd-writer-boundaries.test.js:151` | Só o state-writer escreve `state.json` (varredura estática); escrita por fora quebra o CAS; módulo intruso no SDD é detectado | Rejeição em execução de caminho sem autoridade por subject. CAS isolado não prova exclusividade (F25) |
| O2 | PARCIAL | `scripts/lib/dom06-attempt.test.js:89`; `scripts/lib/routing-admission-watcher.test.js:246`, `:357` | Retry, timeout e resume não fazem upgrade nem rebind; config mudada depois não troca o snapshot; snapshot adulterado não relê a config corrente | Config nova exigir admissão nova; retomada após crash |
| O3 | PARCIAL | `scripts/lib/cost-tracking.test.js:30`; `dashboard/cost-attempts.test.js:156`; `scripts/lib/run-comparator.test.js:118` | Token e custo ausentes ficam `null`; modelo sem preço fica `null`/UNKNOWN na API; PARTIAL/missing nunca vira `passed` | Eval e ponta a ponta. Nota: `scripts/lib/ui-verify-verdict.test.js:30` grava «sem tela verificada» como `FALHOU`/`NO_EVIDENCE`; se isso conflita com «UNKNOWN não vira FAIL» não foi avaliado |
| O4 | PARCIAL | `scripts/invalidate.test.js:394`; `scripts/lib/qa-diagnosis-run-compat.test.js:140`; `scripts/validate-state.test.js:121`; `scripts/lib/dom06-attempt.test.js:189` | Run legado sem `spec_hash` lido como UNKNOWN sem reescrita; Record v1 intacto byte a byte; JSON truncado vira `state_corrupted` com backup; campo novo fica `null` sem backfill | Versão futura de schema |
| O5 | PARCIAL | `dashboard/approval-idempotency-api.test.js:106`; `scripts/lib/redmine-fetch.test.js:76`; `scripts/lib/dom06-attempt.test.js:123`; `scripts/lib/node-lease.test.js:206` | 5xx depois de gravar: reconcilia e não reposta; PUT não repete em 504; efeito DOM06 com a mesma chave não roda duas vezes; commit órfão escala sem redespacho | Crash real do processo; efeito via MCP (ver U-05) |
| O6 | PARCIAL | `scripts/lib/routing-off-golden.test.js:239`; `scripts/lib/qa-rejection-current-golden.test.js:94`, `:191` | Despacho sem routing ou OFF igual ao golden do AS-IS; oráculo C0 da Recusa QA | Caminho ON; demais fluxos; prova de que o golden veio da revisão AS-IS |
| O7 | UNKNOWN | — | Faceta isolada: Verify recusa evidência UNKNOWN (`scripts/lib/spec-authority.test.js:237`) | Teste que ligue requisito → dependência (HARD/CONTRACT/gate) e recuse UNKNOWN no corte |
| O8 | UNKNOWN | — | Testes de contrato usam o módulo dono real, não stub (`dashboard/routing-projection.test.js:142`, `:320`) | Teste contra contrato mínimo com stub permitido, mostrando o que o stub não prova |
| O9 | PARCIAL | `scripts/lib/authorization.test.js:129`, `:195`; `scripts/lib/classifier-guard.test.js:117` | Agente só pede; execução sem cópia congelada ou com cópia forjada não roda; guarda do classificador falha fechada | Conteúdo externo (Redmine) tentando autorizar efeito. `subagent-block.test.js:164` confere só o argv; hooks `.claude/hooks/*.test.mjs` não estão na receita |
| O10 | PARCIAL | `scripts/sanitize-log.test.js:108`; `harness/run-tests.test.js:46`; `dashboard/transcripts-api.test.js:63` | Token sai `[REDACTED]` no log; env dos testes só com allowlist; transcript servido com segredo redigido | Events, telemetry, fixtures de Eval; canário por canal |
| O11 | UNKNOWN | — | Só retenção por idade (`scripts/cleanup-transcripts.test.js:33`, `:47`) e identidade de projeto no SDD (`scripts/lib/sdd-writer-decide.test.js:113`) | Autorização por projeto, finalidade e escopo desde a primeira retenção; lineage |
| O12 | PARCIAL | `dashboard/state-version-api.test.js:95`; `dashboard/authorization-api.test.js:206`; `dashboard/tickets-api.test.js:119` | Tela velha leva 409 sem aplicar nada; autor vindo do body é ignorado; cache não autoriza início | ACK ou 200 não valer como mutação confirmada |
| O13 | UNKNOWN | — | Telas mostram specHash, provider e modelos de cada lado (`scripts/lib/run-comparator.test.js:215`; `dashboard/routing-projection.test.js:262`) | Refs de case, fixture, grader, prompt e config fixadas, ou diferença declarada ou recusada |
| O14 | PARCIAL | `scripts/state-concurrency.test.js:260`, `:320`, `:743`; `scripts/lib/dispatch-reservation.test.js:216` | Um vencedor entre processos; SIGKILL entre fsync e rename deixa o estado íntegro; reserva de `operation_id` exclusiva; um só agente entre watcher e dashboard | Estado + versão + desfecho de idempotência atômicos sob crash |
| O15 | PARCIAL | `dashboard/approval-idempotency-api.test.js:85`, `:106`; `scripts/lib/sdd-writer-replay.test.js:22`, `:34` | Mesmo `operation_id` gera um efeito e recupera o desfecho; replay devolve o histórico; payload diferente dá CONFLICT | OpId não global (mesmo id em dois subjects) |
| O16 | PARCIAL | `scripts/lib/dom06-attempt.test.js:18`; `scripts/lib/routing-admission-watcher.test.js:357`, `:482`; `scripts/lib/dom06-dispatch-env.test.js:295` | Attempt só começa depois de ADMITTED; record adulterado ou apagado impede o início; DENIED/UNKNOWN não despacha | Falha de I/O ao gravar o record; fidelidade record × contexto entregue |
| O17 | PARCIAL | `scripts/lib/model-routing-decomposed.test.js:82` | Versão de CLI fora das provadas → `UNVERIFIED`/`CLI_VERSION_NOT_PROVEN`; versão ausente → `CLI_VERSION_UNKNOWN` | Despacho sem `--agents` nesse caso; `schema_version` futura em state, Attempt ou snapshot; `CAPABILITY_NOT_SUPPORTED` |
| O18 | PARCIAL | `scripts/lib/acceptance-evidence.test.js:253`, `:232`; `scripts/invalidate.test.js:394` | PASS relatado com teste falhando não passa no Verify; AC novo depois do Test é detectado (STALE); evidência UNKNOWN recusada | Saída de grader ou provider no lugar do owner |
| O19 | PARCIAL | `scripts/lib/jev-client.test.js:170`; `scripts/lib/classifier-shadow.test.js:240`; `scripts/lib/jev-calibration.test.js:136` | Prompt do classificador com hash e versão estáveis; envelope fica na Run e o Attempt guarda só o hash | Contaminação (case ou expected visto pelo grader); modelo do grader fixado (o teste usa o nome `jev-latest` como fixture) |
| O20 | PARCIAL | `scripts/lib/dry-run-flag-watcher.test.js:132`; `scripts/lib/dry-run.test.js:231`; `scripts/lib/classifier-shadow.test.js:207` | `--dry-run` não muda memory, `.graph` nem worktrees e não faz não-GET; DRY_RUN fecha o ciclo sem Redmine, claude, mvn nem Bitbucket; sombra não muda o Attempt primário | Isolamento de Eval; a sombra chama o Jev de verdade; GET ainda sai no dry-run |
| O21 | PARCIAL | `scripts/lib/run-comparator.test.js:118`, `:130`, `:150`; `scripts/compare-runs.test.js:53` | PARTIAL/missing preservados; sem prova → `inconclusive`; custo parcial marcado por lado | Nível de case |
| P1 | PARCIAL | `scripts/lib/cost-tracking.test.js:43`, `:18`, `:513` | Dedupe por `message.id`; retry soma no nó; atribuição ao subagente | Fallback entre providers; Attempts abortados; reconciliação com a fonte |
| P2 | PARCIAL | `scripts/lib/cost-tracking.test.js:30`; `scripts/lib/routing-cost-compare.test.js:46`; `dashboard/cost-attempts.test.js:171` | Ausente fica `null`; soma conhecida + contagem sem preço; troca de tabela não reprecifica histórico | Propagação ponta a ponta |
| P3 | PARCIAL | `scripts/lib/decomposition-runtime.test.js:212`; `scripts/lib/session-limit-dispatch.test.js:118` | Indisponibilidade sem mutação não consome o teto; com mutação bloqueia (caminho humano); erro sem assinatura de estouro segue o caminho «indisponível» sem marcar `session_limit` | Sem limite configurado, comportamento igual; «sem mutação» mede só o worktree (U-05) |
| P4 | PARCIAL | `scripts/lib/dom06-decomposition.test.js:59`, `:175`; `scripts/lib/routing-cost-compare.test.js:240` | OFF ignora decomposição; agregação só com todas as chaves e idempotente; comparador lê o estado do `mergeRun` real | S1 = Run explícito |
| P5 | PARCIAL | `scripts/lib/cost-tracking.test.js:470`; `dashboard/cost-attempts.test.js:179` | Agregado principal + subagente reproduzido com dedupe | Reconciliação com a cobrança do provider; separar custo operacional e de avaliação |
| P6 | UNKNOWN | — | Calibração do classificador mostra N e missing (`scripts/lib/jev-calibration.test.js:93`) | Comparação de qualidade case a case com versões e N |
| P7 | UNKNOWN | — | Razão com denominador zero dá `null` (`scripts/lib/routing-cost-compare.test.js:118`) | KPI de custo por resultado (IE005 OPEN). Nota: `:32` calcula a média só sobre Runs completas; a população fica para quem decidir o KPI |

Não executados e relevantes: `dashboard/compare-model.test.js`, `dashboard/agent-log-api.test.js`, `scripts/effect-authority.test.js`, `scripts/consumer-seam.test.js`, `.claude/hooks/*.test.mjs` (estes rodam só no `processo-check` de PR).

## Falhas locais classificadas (U-24)

Falha real (regressão) observada: **nenhuma**. Falhas de ambiente: 2 grupos. Intermitentes: 2.

| Teste | Ocorrência (k/N) | Classe | Causa |
| -- | -- | -- | -- |
| `scripts/architecture-boundaries.test.js:55` «PRI-104 architecture boundaries», 3 subtestes de depcruise | 3/3 em Node 20; 0/1 em Node 22; 0 no CI | Ambiente | `dependency-cruiser` ^18.7 exige Node `^22`, `^24` ou `>=26` e recusa Node 20.20.2 («node version … is not supported», no TAP). O runbook ainda dá Node 20.20.2 como referência; o CI usa 22 e 24 |
| `scripts/lib/qa-rejection-c0-oracle.test.js:197` e `scripts/lib/qa-rejection-current-golden.test.js:233` «C0: árvore adversarial…» | 0/3 rodadas com TMPDIR sem symlink; 1/1 rodada com TMPDIR em `/var/folders` (os 2 testes falham) | Ambiente | No macOS, `/var` é symlink para `/private/var`. O teste compara `realpathSync` com o caminho literal. A receita da skill `prisma-tests` (`EV="$(mktemp -d)"`) cai em `/var/folders` e reproduz a falha. O CI Linux passa |
| `scripts/lib/watcher-lock.test.js:175` «trava velha: o laço retoma e sobe» | 1/3 em Node 20; 0/1 em Node 22; 0 no CI | Intermitente | ENOENT no marcador do filho. O teste espera 200 ms fixos (`:191`). Que a carga cause a falha não foi provado. Já visto no Node 24 (`tasks/pri-287-s5/evidence-s5.2a.md:69-72`) |
| `scripts/lib/graceful-shutdown.test.js:287` «e2e: watcher idle … sai em < 1s com exit 0» | 1/3 em Node 20; 0/1 em Node 22; 0 no CI | Intermitente | Levou 1265 ms contra o limite de 1000 ms (`:298`). Tempo de relógio com os arquivos rodando em paralelo. Mesma ressalva sobre a carga |

Cruzamento com a [PRI-359](https://linear.app/prisma-app/issue/PRI-359). Ela registra 11 falhas numa SHA anterior (worktree da PRI-274):

- **depcruise (3)**: reproduzidas aqui. Classe ambiente (Node 20).
- **C0 adversarial (2)**: reproduzidas só com TMPDIR em `/var/folders`. Classe ambiente. Confirma `tasks/pri-287-s5/evidence-s5.1.md:38`.
- **consumer B (2)** e **fundação TS (4)**: não reproduzidas na `7da4e97`. Passaram nas 3 rodadas Node 20, na Node 22 e no recorte com TMPDIR em `/var/folders`. A causa na SHA da PRI-274 segue `UNKNOWN`. Nesta SHA elas não falham.
- A instabilidade de `cost-tracking.test.js` citada em `tasks/todo.md:120` não apareceu nas 4 rodadas.

Vazamento de isolamento (não é falha, mas a suíte escreve fora do sandbox): `scripts/lib/dom06-decomposition.test.js:245` (AC-09) provoca um `SESSION_CONFLICT` num run em TMPDIR. `scripts/cas.js:439-451` não acha `/memory/runs` nesse caminho, cai em `REPO_PATH` e corta em `/.claude/worktrees/`. Rodada a receita num worktree dentro do checkout principal, a linha vai para `<checkout principal>/logs/state-conflicts.jsonl`. As 4 rodadas desta fatia acrescentaram 4 linhas (`task_id` `run16`, 18:15:29Z, 18:23:33Z, 18:31:37Z e 18:36:09Z) ao arquivo não rastreado do checkout vivo `~/Workspace/prisma`. Nada foi apagado. 46 das 47 linhas do arquivo são esse fixture. Isso explica a «observação lateral» do PR #149. No CI não acontece, porque não existe `.claude/worktrees/`.

Regra local × CI: o CI (Linux, Node 22/24) fica verde nesta SHA. A referência local do runbook (Node 20.20.2) e o TMPDIR da skill produzem 5 falhas de ambiente fixas no macOS. Alinhar essa referência fica com a PRI-359.

## U-05: retry de MCP repete efeito externo?

**Resposta: sim, existe caminho estrutural.** Não há retry *de MCP* em si. O efeito pode se repetir porque o nó é redespachado sem conferir o que a sessão anterior fez pelo MCP, ou porque o próprio comando manda «tente de novo». Com os comandos atuais, o único efeito MCP instruído leva sempre ao mesmo status. Leitura de fonte na SHA `7da4e97`. Nenhum teste exercita esse caminho.

1. O retry com throttle do watcher só cobre as chamadas REST que o próprio watcher faz. Ele não repete método não-GET com desfecho incerto: `scripts/lib/redmine-fetch.js:11-13`, `:23` e `:105-110`. Teste: `scripts/lib/redmine-fetch.test.js:76`.
2. A sessão de cada nó recebe todas as ferramentas MCP do Redmine, sem filtro: `--allowedTools 'mcp__redmine__*,…'` em `scripts/readmine-watcher.js:4355`. O watcher não registra quais chamadas MCP a sessão fez nem com que chave.
3. Há três caminhos em que o mesmo nó volta a rodar numa sessão nova:
   - **Nó órfão** (agente ou watcher morreu): nó comum volta a `in_progress` e é redespachado no tick seguinte (`scripts/lib/node-lease.js:16-19` e `:340-353`; teste `scripts/lib/node-lease.test.js:283`). Só o nó `commit` escala sem redespacho (`node-lease.js:330-339`). A nota de recuperação manda conferir só `git status/diff` (`node-lease.js:368-377`).
   - **Provedor indisponível**: o tick seguinte tenta de novo (`scripts/readmine-watcher.js:5310-5316`).
   - **Run decomposta**: o retry automático exige «sem mutação observada no workspace» (nota em `scripts/readmine-watcher.js:1760`; teste `scripts/lib/decomposition-runtime.test.js:212`). A mutação é medida por `manifest.observe({ worktree, … })` (`scripts/lib/decomposition-runtime.js:66-74` e `:111-124`), ou seja, só no worktree. Um efeito feito pelo MCP no Redmine não aparece nela.
4. O que os comandos mandam fazer via MCP hoje:
   - `fetch_ticket` muda o status para «Em Desenvolvimento» com `mcp__redmine__updateIssue` (`.claude/commands/fetch-ticket.md:101-108`). O próprio comando manda «tente de novo» quando a transição falha. Repetir leva ao mesmo status. Se o Redmine grava journal ou dispara workflow de novo nesse caso é `UNKNOWN`.
   - `commit` muda o status para «Ag Merge» pelo efeito governado do DOM06, não pelo MCP (`.claude/commands/commit.md:186-197`). Esse caminho tem chave de idempotência e devolve `DUPLICATE` (`scripts/lib/dom06-attempt.js:454-455`; teste `scripts/lib/dom06-attempt.test.js:123`).
   - Nenhum comando manda criar nota, horas ou issue pelo MCP. O próprio `commit.md:263-264` avisa que o MCP «não consulta a autoridade do Attempt e pode duplicar a nota». Mas a permissão é `mcp__redmine__*`, então nada impede uma sessão de chamar uma ferramenta não idempotente. Se chamar e o nó for redespachado, o efeito pode se repetir.
   - Há um segundo caminho fora do MCP: `--allowedTools` também libera `Bash`, e `cleanAgentEnv` (`scripts/readmine-watcher.js:3535-3540`, usado em `spawnAgent`, `:3644`) não remove `REDMINE_*` do ambiente da sessão. Uma chamada REST não idempotente feita pela sessão também ficaria fora do retry seguro e do DOM06.
5. `UNKNOWN`: o servidor MCP do Redmine não está configurado neste repositório (`.mcp.json` só tem `playwright`). Se ele mesmo faz retry interno, e se o consumidor tem hook ou deny para `mcp__redmine__*`, não dá para saber daqui.

Resumo: o retry REST do watcher é seguro para não-GET. O efeito feito pela sessão (MCP ou REST via `Bash`) não tem chave, registro nem conferência antes do redespacho. Hoje, o único efeito MCP instruído leva sempre ao mesmo status. Fechar o risco é decisão de escopo (por exemplo, restringir `--allowedTools` ou passar efeitos pelo DOM06), fora desta fatia.

## Limites

- Leitura de testes conservadora: um título forte pode cobrir mais do que o registrado. O inverso também vale.
- A rodada local roda em macOS com Node 20.20.2. O CI roda em Linux com Node 22 e 24. As versões diferem.
- Não foi verificado se o consumidor vivo roda esta SHA (U-01, F1).
- U-25 (CURRENT verificável): esta tabela dá a cobertura por SHA para `7da4e97`. Árvore e release do consumidor continuam `UNKNOWN`.
