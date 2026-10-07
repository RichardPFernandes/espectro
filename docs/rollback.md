# Retorno do consumo do Prisma para os scripts do app-back (PRI-62)

Procedimento para voltar o app-back a executar os próprios scripts depois de ter
consumido a candidata `fbb597cb2ffe6053351a5d6ed2bff6e444bf3b6c` (tree
`4633d9fd5f5bdf30c6be9f990d84cb847a9cb3cc`). Este documento não autoriza parar,
reverter ou trocar uma execução ativa. Ele só vale para a revisão acima; outra
revisão de cutover precisa de delta validado (ver "Cobertura").

Hoje não há cutover: a execução ativa é `app-back/scripts/readmine-watcher.js`, cujos
236 arquivos selecionados conferem por hash com o snapshot da fonte. Nesse estado, o
retorno é não usar o comando de consumo da candidata.

## O que muda entre os dois modos

| | Fonte (retorno) | Candidata |
|---|---|---|
| Executável | `app-back/scripts/readmine-watcher.js`, `app-back/dashboard/server.js` | `$PRISMA_ROOT/scripts/readmine-watcher.js`, `$PRISMA_ROOT/dashboard/server.js` |
| Raiz do consumidor | `REPO_PATH` (do `.env`) | `REPO_PATH` ou cwd |
| `.env` lido | `app-back/.env` (`__dirname/..`) | `$REPO_PATH/.env`, o mesmo arquivo |
| Config extra | nenhuma | `prisma-consumer.env` + `config/consolidator-module-keywords.json` (conjunto admitido) |
| Templates de nó | `app-back/.claude/commands/` | `$PRISMA_ROOT/.claude/commands/` |
| Estado | `app-back/memory/runs`, o mesmo nos dois modos | idem |

A candidata não grava código nem config no consumidor; só `memory/` (ensaio C2–C4).
O retorno, portanto, não restaura arquivo nenhum do app-back. Se o checkout do app-back
tiver mudado, isso é drift (passo 5), não algo a reverter.

Config de consumo admitida (decisão do Richard na PRI-61/PRI-62): `prisma-consumer.env`
e `config/consolidator-module-keywords.json`, na raiz do app-back. Os arquivos
`scripts/prisma-consumer.env.example` e `.claude/prisma-*.json` são só exemplos: não
fazem parte da identidade da config nem do retorno.

Hash atual de `prisma-consumer.env`: `767066520961af1bf36476ba52e217826d884220b4f82b61e95a575f0f69fa29`
(PRI-65, 2026-10-07). O anterior (`44a91f61…`) não exportava `PRE_BUILD_COMMAND`,
`TEST_COMMAND` e `TEST_SCOPED_COMMAND` no `source` (valor com espaço sem aspas); o novo
põe aspas nesses valores e faz o `set -a`/`set +a` no próprio arquivo. Carregar com
`source ./prisma-consumer.env` (zsh ou bash); o loader dotenv lê os mesmos valores.

## Quem e quando

- Executor: quem opera o watcher do app-back neste host.
- Autoridade: decisão registrada do Richard (issue de cutover/incidente) antes de
  qualquer passo em execução ativa. Pedido de "preparar" não autoriza executar.
- Gatilhos para pedir a decisão: comportamento diverge da fonte num cenário coberto;
  config/path/ref incompatível; estado deixa de ser legível; não há como provar um
  só writer; falha parcial na troca; efeito externo com resultado incerto; credencial
  revogada sendo exigida. Nenhum gatilho dispara retorno automático.

## Sequência

1. **Fixar o par.** Candidata = revisão/tree acima. Fonte = app-back HEAD
   `a1ac43307cc5f275caf5a70ad3068c9af099b127` mais os bytes selecionados do snapshot
   `memory/runs/pri-62-reversal-preparation/source-snapshot-2026-10-07-pri67-71/source-selected-current.tar.gz`
   (sha256 `1191361d93f1a3dbe609a45bd881c0c8633bf8e491b99b5036b7d251aeda5731`),
   236 arquivos. Inclui a correção do comparador da PRI-61 e, na fonte, PRI-67
   (`--dry-run` sem escrita), PRI-68 (filtro `--ticket`), PRI-70 (trava e identidade
   do agente) e PRI-71 (PR aberto reutilizado; 401/403 não segue para o POST).
   O snapshot anterior permanece em
   `memory/runs/pri-62-reversal-preparation/candidate-fbb597c-2026-10-07/source-selected-current.tar.gz`
   (sha256 `ee42191da8945055f37aca773ec8e585e0d0ae8eb3c23c9a105ff829c2159a03`, 230 arquivos).
   O anterior a esse (`ad618099…`) difere só nos 6 arquivos do comparador (ver manifesto).
   Config admitida: os 2 arquivos acima, com hash em `provenance/pri-62-rollback.json`.
2. **Parar o writer da candidata com SIGTERM** (botão Parar do dashboard da candidata ou
   `kill -TERM <pid>`), nunca SIGKILL. O graceful shutdown marca o nó em voo como
   `interrupted` e registra a nota no Redmine. A garantia de que não sobrou writer é a
   trava, não o `pgrep`:
   `node "$PRISMA_ROOT/scripts/lib/watcher-lock.js" status --repo="$REPO_PATH"`
   (exit 0 = nenhum watcher e nenhum agente destacado vivo; exit 1 = algum dos dois). `pgrep -fl readmine-watcher` é só checagem visual.
3. **Esperar os agentes destacados da candidata.** Para cada `memory/runs/*/state.json`
   com `status: "running"`, compare `agent_pid` + `agent_started_at` com
   `ps -p <agent_pid> -o pid,lstart,command`. O texto do comando (claude, codex, wrapper
   `sh`) não decide: pid reciclado tem outro `lstart` e conta como morto. Lease antigo,
   sem `agent_started_at`, só conta se o processo nasceu na janela de 15 min depois de
   `node_started_at` (`scripts/lib/node-lease.js`). Não matar. Enquanto houver agente
   vivo, não remover nem mover o `$PRISMA_ROOT`: o wrapper libera o lease chamando
   `$PRISMA_ROOT/scripts/lib/node-lease.js`. Agente que sair sem liberar é recuperado
   pela fonte como órfão no mesmo nó (C4); commit órfão vira `needs_human_review`.
4. **Um writer por REPO_PATH.** A trava (PRI-70) fica num caminho derivado do `REPO_PATH`
   (`<REPO_PATH>/.git/prisma-watcher.lock`, ou `/tmp/prisma-watcher-<hash>.lock`), nunca
   em `memory/`. Fonte e candidata enxergam a mesma trava quando as duas rodam este código.
   O segundo watcher não grava nada e sai com exit 75 enquanto o primeiro está vivo; trava
   de processo morto é retomada sem intervenção. `pgrep` antes do tick é checagem, não a garantia.
   A revisão `fbb597c` não contém `scripts/lib/watcher-lock.js`. A trava está no snapshot
   da fonte e no Prisma a partir da PRI-70. Enquanto a candidata em execução for
   `fbb597c`, a recusa do segundo writer só passa a valer quando a fonte deste snapshot sobe.
5. **Conferir drift.** Os 236 arquivos selecionados do app-back devem bater com o
   snapshot (`provenance/pri-62/consumption-rollback.test.js`, caso C0, faz essa leitura).
   Divergência: parar e decidir arquivo a arquivo. Sem `reset --hard`, `clean`, `stash`
   global ou restore em massa.
6. **Config.** Deixar de carregar `prisma-consumer.env` e `PRISMA_ROOT`. Não copiar nem
   restaurar `.env`: os dois modos leem o mesmo arquivo, então credencial revogada
   (retirada do `.env`) continua ausente.
7. **Subir o watcher/dashboard do app-back** do jeito de sempre. Um dashboard só por
   consumidor.
8. **Pós-condições** (no primeiro tick e no seguinte):
   - task `interrupted` continua parada até decisão humana
     (`node scripts/state-writer.js set <run> --set status=in_progress`); ao retomar,
     segue do nó interrompido com o mesmo `execution_id`, sem refazer nós concluídos;
   - gate de spec pendente continua pendente, sem repostar a pergunta; avança só com
     resposta `aprovado` depois da pergunta já postada;
   - nenhum PR aberto de novo (`pull_request` do run arquivado único);
   - nenhum processo da candidata vivo e nenhuma task `running` com agente dela.
9. **Saída ou escalada.** Retorno concluído só com todas as pós-condições. Qualquer
   falha, drift ou resultado incerto: parar a ação dependente e levar ao Richard.

## Cobertura

Ensaio `provenance/pri-62/consumption-rollback.test.js`, sempre em diretórios
temporários, `DRY_RUN=true`, fixtures sintéticas. Resultado registrado no manifesto.

| Caso | O que prova | Limite |
|---|---|---|
| C0 | fonte 236 (hash, tamanho, bit de execução) restaurada do snapshot; candidata 248 do `git archive`; checkout ativo = fonte | só código/assets selecionados |
| C1 | config admitida (2 arquivos) confere com o hash fixado, sem chave de segredo, fora do Prisma; exemplos só listados | não valida semântica da config |
| C2 | nó em voo na candidata → SIGTERM → fonte não retoma sem decisão → retoma do mesmo nó, mesmo `execution_id`, 1 PR | dry-run; efeitos simulados |
| C3 | gate humano aberto na candidata segue pendente na fonte, sem repostar; avança só com `aprovado` | journal do Redmine reproduzido no fixture |
| C4 | agente destacado vivo bloqueia a fonte; morto, a fonte recupera o mesmo nó | o ensaio da PRI-62 usou marcador `claude`; a regra atual (PRI-70) é pid + início do processo |
| C5 | nenhuma escrita no `PRISMA_ROOT` | — |

O retorno de código/refs (local-checkout, CAS) já foi provado em 7 testes na mesma
candidata (run local da PRI-62, `candidate-reversal.tap`).

Não provado por este ensaio (o exercício real pedido pelo Richard é registrado à parte):
Redmine/Bitbucket/agentes reais, revogação real de credencial, Decision
formal além do "aprovado"/`state-writer set` do contrato atual, exclusividade entre hosts (a trava é local; `pgrep` não a substitui), e qualquer revisão diferente de `fbb597c`.
