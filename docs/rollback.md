# Retorno do consumo do Prisma para os scripts do app-back (PRI-62)

Procedimento para voltar o app-back a executar os próprios scripts depois de ter
consumido a candidata `04c130b00b7cce38ee17b1edc1d26ba67cd8c59a` (tree
`6a6b3f559e9270399e96e26bb56ab02c7642285b`). Este documento não autoriza parar,
reverter ou trocar uma execução ativa. Ele só vale para a revisão acima; outra
revisão de cutover precisa de delta validado (ver "Cobertura").

Hoje não há cutover: a execução ativa é `app-back/scripts/readmine-watcher.js`, cujos
230 arquivos selecionados conferem por hash com o snapshot da fonte. Nesse estado, o
retorno é não usar o comando de consumo da candidata.

## O que muda entre os dois modos

| | Fonte (retorno) | Candidata |
|---|---|---|
| Executável | `app-back/scripts/readmine-watcher.js`, `app-back/dashboard/server.js` | `$PRISMA_ROOT/scripts/readmine-watcher.js`, `$PRISMA_ROOT/dashboard/server.js` |
| Raiz do consumidor | `REPO_PATH` (do `.env`) | `REPO_PATH` ou cwd |
| `.env` lido | `app-back/.env` (`__dirname/..`) | `$REPO_PATH/.env`, o mesmo arquivo |
| Config extra | nenhuma | `prisma-consumer.env` (ou `scripts/prisma-consumer.env.example`) + arquivos de taxonomia/ResponseFactory |
| Templates de nó | `app-back/.claude/commands/` | `$PRISMA_ROOT/.claude/commands/` |
| Estado | `app-back/memory/runs`, o mesmo nos dois modos | idem |

A candidata não grava código nem config no consumidor; só `memory/` (ensaio C2–C4).
O retorno, portanto, não restaura arquivo nenhum do app-back. Se o checkout do app-back
tiver mudado, isso é drift (passo 5), não algo a reverter.

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
   `source-selected.tar.gz` (sha256 `ad61809914fbca65f3657b98053a8ae9771f9e50f4bae3abcc0fdeb783163da0`).
   Config do consumidor: hashes em `provenance/pri-62-rollback.json`.
2. **Parar o writer da candidata com SIGTERM** (botão Parar do dashboard da candidata ou
   `kill -TERM <pid>`), nunca SIGKILL. O graceful shutdown marca o nó em voo como
   `interrupted` e registra a nota no Redmine. Conferir que não sobrou processo:
   `pgrep -fl "$PRISMA_ROOT/(scripts/readmine-watcher|dashboard/server)"` sem saída.
3. **Esperar os agentes destacados da candidata.** Para cada `memory/runs/*/state.json`
   com `status: "running"`, ver `ps -p <agent_pid> -o command=`. Não matar. Enquanto
   houver agente vivo, não remover nem mover o `$PRISMA_ROOT`: o wrapper libera o lease
   chamando `$PRISMA_ROOT/scripts/lib/node-lease.js`. Agente que sair sem liberar é
   recuperado pela fonte como órfão no mesmo nó (C4); commit órfão vira
   `needs_human_review`.
4. **Nunca rodar os dois watchers no mesmo consumidor.** Não existe trava de instância:
   `acquireNode` não recusa task `running`, e `agentAlive` só reconhece pid cujo comando
   contém `claude`. A exclusividade depende dos passos 2 e 3.
5. **Conferir drift.** Os 230 arquivos selecionados do app-back devem bater com o
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
| C0 | fonte 230 (hash, tamanho, bit de execução) restaurada do snapshot; candidata 248 do `git archive`; checkout ativo = fonte | só código/assets selecionados |
| C1 | config do consumidor identificada por hash, sem chave de segredo, fora do Prisma | não valida semântica da config |
| C2 | nó em voo na candidata → SIGTERM → fonte não retoma sem decisão → retoma do mesmo nó, mesmo `execution_id`, 1 PR | dry-run; efeitos simulados |
| C3 | gate humano aberto na candidata segue pendente na fonte, sem repostar; avança só com `aprovado` | journal do Redmine reproduzido no fixture |
| C4 | agente destacado vivo bloqueia a fonte; morto, a fonte recupera o mesmo nó | pid simulado com marcador `claude` |
| C5 | nenhuma escrita no `PRISMA_ROOT` | — |

O retorno de código/refs (local-checkout, CAS) já foi provado em 7 testes na mesma
candidata (run local da PRI-62, `candidate-reversal.tap`).

Não provado: Redmine/Bitbucket/agentes reais, revogação real de credencial, Decision
formal além do "aprovado"/`state-writer set` do contrato atual, exclusividade global
entre hosts, e qualquer revisão diferente de `04c130b`.
