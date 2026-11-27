# Estudo: o que o Espectro pode trazer do Orca

> **Status:** priorizado em 27/11/2026 na D16 (`roadmap/DECISOES.md`): só o que alimenta a F3.7 entra
> agora; o resto foi para a Fase 6 com gatilho (F6.17 a F6.21). Issue: PRI-422.
> **Origem:** pedido do Richard em 25 e 26/11/2026 ("uso muito o Orca e acho incrível"; "seria
> interessante conversar com o terminal em si no Espectro"). Código lido em `main` `80b07de`.
> Orca lido no README público ([stablyai/orca](https://github.com/stablyai/orca)) em 26/11/2026.

## Resumo

O que vale trazer do Orca é o modelo de trabalho, não a casca (terminais, painéis, app de
celular). O Orca já roda qualquer agente de CLI e os próprios agentes o controlam pela CLI dele;
então o caminho barato é o Espectro rodar dentro do Orca e ficar só com o que tem de próprio:
o grafo com portões, o estado da run e os dados comparáveis.

Duas frentes valem o esforço:

- **A. Best-of-N**, como método da prova de valor (F3.7, D15): o mesmo ticket em braços
  paralelos, cada um na sua worktree, e o agente direto como mais um braço.
- **B. Intervenção humana na run**: poder conversar com o agente no meio da run, em três níveis,
  sem perder o que distingue o Espectro de "Claude Code com passos extras".

O achado que barateia as duas: o Espectro já tem quase toda a base. Cada ticket já roda numa
worktree própria, cada nó já é despachado com `--session-id` fixo e o dashboard já aceita
mensagem humana numa run bloqueada.

## O que o Espectro já tem

| Base | Onde | O que permite |
| -- | -- | -- |
| Uma worktree por ticket, em `.claude/worktrees/<id>` | `worktreePathFor` e `ensureTicketWorktree` no watcher | Isolamento por ticket, sem stash. Não permite dois braços do mesmo ticket: a worktree e a branch têm o id do ticket |
| `--session-id` fixo em cada despacho de nó | `scripts/readmine-watcher.js` (argv do `claude -p`), `session_id` no ledger de custo | Toda sessão de nó é endereçável depois. É o que torna barato "entrar na sessão" |
| Conta do Claude Code por run (`claude_config_dir`) | `scripts/lib/claude-account.js` | A sessão só é retomável com o mesmo `CLAUDE_CONFIG_DIR`. Um "entrar na sessão" precisa usar a conta gravada na run |
| Mensagem humana numa run bloqueada, interpretada antes de destravar | `scripts/lib/human-input-intent.js`, capacidade `autorizacao` | Já existe canal humano → run. Só vale para run `blocked`, e a mensagem vira retomada de nó, não conversa |
| Pausas de aceite: spec, `SPEC_CHANGE`, portão do plano com nota baixa | portões no watcher | Já há pontos em que a run para e espera gente |
| Agente vivo nunca é declarado órfão (ESTADO-I03) | capacidade `estado` | Regra que qualquer "entrar na sessão" tem de respeitar: nunca dois agentes na mesma worktree |

## Mapa Orca → Espectro

| Recurso do Orca | No Espectro hoje | Proposta | Destino |
| -- | -- | -- | -- |
| Worktrees paralelas, uma por tarefa | Uma worktree por ticket | Permitir N braços por ticket só no experimento | Frente A |
| Orquestrar agentes: um coordenador divide e dispara workers | Grafo fixo; decomposição em piloto (PRI-341, F2.2) | Nada novo: a decomposição já é a aposta equivalente | Sem mudança |
| Chat ou terminal, mover a conversa entre os dois sem perder contexto | Sessão de nó endereçável, mas ninguém a abre | Comando que abre a sessão do nó na worktree certa | Frente B, nível 2 |
| "Needs you": avisa quando o agente precisa de você, inclusive no celular | Fila "Aguardando você" planejada (F4.4) | Expor as sessões num formato que o Orca abra; o aviso fica com ele | Frente B, nível 3 |
| Notas em linhas exatas do diff, mandadas de volta ao agente | Mensagem humana em texto livre | Aceitar nota por arquivo e linha como formato da mensagem humana | Fase 6, junto da F6.8 |
| Tarefa do Linear ou do GitHub vira worktree | Ticket do Redmine vira run | Não trazer: o canal é o Redmine (D7) e o escopo é o fluxo de código (D2) | Fora |
| CLI que os agentes usam para controlar o Orca | — | Não reimplementar; usar a do Orca quando o Espectro rodar dentro dele | Frente B, nível 3 |
| Casca: painéis, split, browser, app de celular, plugins | Dashboard próprio | Não trazer | Fora |

## Frente A — Best-of-N como método da prova de valor

**O que é.** O mesmo ticket roda em N braços ao mesmo tempo, cada um na sua worktree. Ao fim,
compara-se custo, tempo do Richard e resultado, e o melhor vira o PR. No Orca isso é natural:
várias worktrees lado a lado, com o diff de cada uma.

**Por que encaixa.** A F3.7 já compara o Espectro com o agente direto (Claude Code com o fluxo
`/pri-*`) em três tickets de ouro, e a medida principal é o tempo do Richard (D15). Best-of-N é
o desenho natural desse experimento: os braços correm juntos, sobre a mesma base, e o agente
direto entra como mais um competidor. Também mede algo que a F3.7 ainda não mede: quanto o
resultado varia de uma run para outra do mesmo braço.

**Proposta.**

1. **Agora, sem código no runtime.** Escrever o método da F3.7 como best-of-N: por ticket de
   ouro, um braço Espectro e um braço agente direto, cada um numa worktree, rodados no Orca, com
   a mesma base e o mesmo ticket. Se o orçamento deixar, um segundo braço Espectro para medir
   variância. Registrar no quadro o tempo do Richard por braço, inclusive o de revisão.
2. **Depois, só com gatilho.** Best-of-N dentro do runtime (N braços automáticos por ticket)
   só se a F3.7 mostrar variância alta entre runs do mesmo braço. Vira item condicional da
   Fase 6.

**O que fica de fora.** Best-of-N ligado por padrão. Custa N vezes por ticket e contraria
"um piloto de custo por vez" enquanto a meta de custo (D1, D6) segue em aberto.

**Limite técnico.** O watcher amarra worktree, branch e run ao id do ticket. Um braço extra do
Espectro no mesmo ticket precisa de outro `REPO_PATH` (outro checkout do launcher do piloto),
não de mudança no watcher. Isso basta para o experimento.

## Frente B — Intervenção humana na run

**O problema.** No agente direto, o Richard corrige o rumo no meio do caminho. Numa run do
Espectro, se o agente errou na fase 2, ele só descobre no fim, depois de gastar tudo. É uma
causa provável da percepção de que "com o agent-skills direto é melhor".

**O cuidado.** Não virar um terminal interativo puro. Se cada run vira conversa, o Espectro
perde o fluxo reproduzível e os dados comparáveis. Toda intervenção precisa ficar registrada
na run, para que a métrica separe "run sozinha" de "run com ajuda".

### Nível 1 — Pausas opcionais no fluxo

A run para depois do plano e depois de cada nó escolhido, mostra o que fez e espera. O Richard
conversa (nível 2) ou manda seguir. Liga por run, não para todas.

- Já há quase tudo: a run pausada é um status que existe, e a mensagem humana já destrava
  (`human-input-intent.js`).
- **Conflito com a D9.** A D9 assumiu "mesmos pontos de decisão, com melhor evidência e aviso",
  contra "mais pontos de decisão". Pausas opcionais são mais pontos. Por isso este nível pede
  uma decisão nova (D16, abaixo). Recomendação: pausas só quando pedidas para a run, desligadas
  por padrão; a D9 continua valendo para o fluxo padrão.

### Nível 2 — Entrar na sessão do nó

Um comando (por exemplo `npm run run:attach -- <ticket> [nó]`) que abre `claude --resume
<session_id>` na worktree do ticket, com o `CLAUDE_CONFIG_DIR` gravado na run. O Richard conversa
com o mesmo agente, com todo o contexto que ele tinha.

- **Só quando não há agente vivo** na worktree: nó já terminou, run pausada ou bloqueada.
  Com agente vivo, o comando recusa (ESTADO-I03: nunca dois agentes na mesma worktree).
- **Registro.** Ao sair, o comando grava um evento de intervenção humana no `state.json`
  (nó, duração, se houve mudança na worktree). O recibo da run (F2.8) e a linha de base (F1.5)
  passam a separar runs com e sem intervenção.
- **Retomada.** Depois da conversa, a run segue pelo canal que já existe: mensagem humana
  dizendo de qual nó seguir, interpretada pelo `human-input-intent.js`.
- **Hipótese a provar primeiro.** Que `claude --resume` abre de forma interativa uma sessão
  criada por `claude -p` com `--session-id`, na mesma conta. Uma sonda curta, no padrão de
  `scripts/probes/`, confirma antes de qualquer fatia.

### Nível 3 — Deixar o Orca ser a interface

Se cada nó roda como agente de terminal numa worktree, o Orca já dá a conversa, o aviso de
"precisa de você" e o celular. O Espectro só precisa expor as sessões direito: para cada run,
worktree, `session_id` do nó atual, conta e estado, num arquivo ou comando que o Orca (ou
qualquer terminal) leia.

- Encaixa na aposta "nós como skills de um plugin com runner fino" (estudo "O que falta e como
  acelerar", A23), que a D15 manda avaliar se o Espectro empatar ou perder na F3.7.
- Encosta na F4.4 (fila "Aguardando você"): a fila do dashboard e o aviso do Orca leem o mesmo
  estado.

**Ordem recomendada.** Nível 2 primeiro, porque é o mais barato, não depende de decisão nova e
já resolve o "quero falar com o agente". Nível 1 depois da D16. Nível 3 depois do resultado da
F3.7.

## Onde entra no roadmap (proposta)

Nada disto mexe no `ROADMAP.md` neste PR. Se o Richard aprovar, o PR seguinte faz as mudanças
abaixo nos `FASE.md` e em `DECISOES.md`.

| Item | Proposta | Nível | Por quê ali |
| -- | -- | -- | -- |
| Best-of-N como método | Entra nos ACs da F3.7, sem fatia nova | Leve | É desenho de experimento, e a F3.7 roda já, ao lado da Fase 1 (D15) |
| Sonda do `--resume` | Uma linha na F3.7 ou fatia de 1 dia na Fase 1 | Leve | Destrava o nível 2 sem custo; só leitura |
| Nível 2: entrar na sessão + registro de intervenção | Fatia nova na Fase 2, frente A, logo antes da F2.8 | Médio, atrás de flag | O recibo da F2.8 é onde a intervenção aparece; a Fase 2 já mexe no runtime |
| Nível 1: pausas opcionais | Fatia na Fase 4, ao lado da F4.4, se a D16 aprovar | Médio | A pausa precisa da fila e do aviso para não virar run esquecida |
| Nível 3: expor sessões para o Orca | Item condicional da Fase 6, gatilho: resultado da F3.7 | Médio | Só faz sentido se a aposta do runner fino entrar em avaliação |
| Best-of-N no runtime | Item condicional da Fase 6, gatilho: variância alta na F3.7 | Médio | Custa N vezes; só com dado |
| Nota por linha do diff | Junto da F6.8 | Médio | Mesmo gatilho do gate manual |

A Fase 2 já tem duas frentes. A fatia do nível 2 entra na frente A, ao lado da F2.8, e não abre
terceira frente.

## Decisões pedidas ao Richard

| ID | Pergunta | Recomendação | Alternativa |
| -- | -- | -- | -- |
| D16 | Pausas por run, pedidas pelo Richard, convivem com a D9? | Sim: desligadas por padrão, ligadas por run; a D9 vale para o fluxo padrão | Manter a D9 sem exceção e ficar só com o nível 2 |
| — | Aprovar a tabela "Onde entra no roadmap"? | Sim, começando pela sonda e pelo método da F3.7 | Escolher só parte dela |

## Fora deste estudo

- A casca do Orca: terminais, painéis, browser, app de celular, plugins.
- Tarefa do Linear ou do GitHub virar run: o canal segue o Redmine (D7) e o escopo segue o
  fluxo de código (D2).
- Orquestração com coordenador e workers: o piloto de decomposição (F2.2) já é essa aposta.
