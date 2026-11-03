# Espectro — Dashboard

Dashboard local (interface no design Espectro: tokens em `public/prisma-theme.css`, base e
componentes em `public/theme.css`, CSS de cada tela em `public/screens/`) de observabilidade do watcher (`scripts/readmine-watcher.js`) com um
canal humano→agente: você acompanha os runs do grafo em tempo real e manda instruções
pro agente sem matar o processo.

## Como iniciar

```bash
cd dashboard
npm install
cp .env.example .env
npm start
# abrir http://localhost:3333
```

`npm run dev` reinicia sozinho quando `server.js` muda. `npm test` roda os testes do
servidor (repo sintético, não toca nos runs reais).

## Primeiro uso em outro computador (Este computador)

Num computador sem configuração (pasta do projeto inválida ou Redmine sem endereço/chave), o
dashboard abre sozinho a tela **Este computador** em tela cheia; depois ela fica em
Plataforma › Este computador. Três etapas:

1. **Reconhecer**: procura Git, Node 20+/npm, Claude Code e Codex (opcional) e mostra o
   comando quando falta algo. Nada é instalado pelo painel.
2. **Configurar**: pasta do repositório do projeto, conta do Claude, Redmine e Bitbucket
   (opcional). A pasta vai para `REPO_PATH` no `dashboard/.env` do Prisma e vale depois de
   reiniciar; se `REPO_PATH` vier do ambiente (launcher do consumidor), fica travada. Redmine
   e Bitbucket vão para o `.env` da raiz do projeto (as mesmas chaves do watcher); a conta,
   para `claude_config_dir` no `dashboard-prefs.json`. Chave em branco mantém a salva e
   nenhuma chave volta pela API.
3. **Pronto**: testa só com leitura (git do repo, `GET /users/current` no Redmine, `GET` do
   repositório no Bitbucket, contrato de configuração) e a sondagem mínima do Claude, que
   gasta um pouco da cota.

Rotas: `GET /api/onboarding/tools`, `GET|PUT /api/onboarding/config`,
`GET /api/onboarding/repo?path=`, `POST /api/onboarding/check` (`onboarding.js`, testes em
`onboarding-api.test.js`).

## Configuração (`.env`)

| Variável       | Padrão            | O que é |
|----------------|-------------------|---------|
| `PORT`         | `3333`            | Porta HTTP + WebSocket. |
| `MEMORY_DIR`   | `../memory/runs`  | `memory/runs` do checkout principal (relativo a `dashboard/`). |
| `WORKTREES_DIR`| `<repo>/.claude/worktrees` | Onde procurar `*/memory/runs`. Deduzido de `MEMORY_DIR`. |
| `HOST`         | `127.0.0.1`       | Interface de escuta. Não exponha fora do loopback: não há auth. |
| `REDMINE_URL`, `REDMINE_API_KEY` | `.env` do repo | Proxy do ticket (seção "Ticket Redmine"). |
| `BITBUCKET_API_TOKEN` | `.env` do repo | Proxy do status do PR (Bearer, igual `scripts/bitbucket-open-pr.sh`). |
| `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG` | `.env` do repo | Só usados quando o PR gravado não tem URL; normalmente workspace e repositório saem da própria URL do PR. |
| `SPEC_APPROVAL_KEYWORD` | `aprovado` | Palavra que o botão **Aprovado** posta no ticket (a mesma que o watcher procura). Não é segredo. |
| `WATCHER_TICK_INTERVAL_MS` | `60000` | Intervalo entre ticks do watcher quando ele é iniciado pelo painel (seção "Controle do watcher"). |

As credenciais das integrações vêm, nesta ordem, do ambiente, do `dashboard/.env` e do
`.env` da raiz do repo (o mesmo que o watcher lê; do arquivo da raiz só essas 5 chaves, as
`PREVIEW_*` e `SPEC_APPROVAL_KEYWORD` são lidas). Não é preciso copiá-las para `dashboard/.env`. `KEY=` vazio não conta.


## Coordenação (somente leitura)

A aba **Coordenação** lê `GET /api/coordination`; não despacha agentes nem grava estado.
`COORD_STATUS_PATH` configura o JSON do Coordenador. No `npm start`, a
ausência da variável (ambiente e `.env` do dashboard) usa
`~/.maestro-guard/coord-status.json`. Um servidor criado sem esse caminho,
como na suíte de testes, observa um arquivo temporário próprio e não o
arquivo real do usuário. Fonte v1:

```json
{"schemaVersion":1,"updatedAt":"2026-10-10T15:00:00Z","frentes":[{"id":"prisma","nome":"Prisma","restricted":false}],"tarefas":[{"id":"PRI-99","frente":"prisma","tarefa":"Coordenação","agente":"Codex","runtime":"codex","estado":"Em andamento","nota":"Implementar","link":"https://linear.app/prisma-app/issue/PRI-99","atualizado":"2026-10-10T15:00:00Z"}]}
```

`restricted` é booleano, default `false`. Para frente restrita (incluindo M&O),
o produtor publica somente nome da frente, nome da tarefa e estado, conforme
instrução do Coordenador, além dos IDs estruturais. `id` é obrigatório e único
em toda tarefa, inclusive nas restritas; a API o usa para validar a fonte e
descarta **id da tarefa, nota, agente, runtime, link e atualizado**. A resposta
mantém `frente` para agrupamento, `tarefa` e `estado`. A aba também omite essas
colunas, mesmo se recebesse campos extras. Campos desconhecidos são ignorados.
Estados: Em andamento, Na fila, Aguardando você, Concluído, Bloqueado.
Arquivo ausente resulta em `empty`; ilegível/inválido em `invalid` com mensagem
fixa, sem ecoar dados. Contadores sem fonte válida são `null` (sem medição),
não zero. Chokidar observa apenas esse arquivo com polling de 250ms (cobre
arquivo inicialmente ausente e rename atômico no macOS) e publica
`coordination_update` pelo WebSocket; o cliente relê a rota, inclusive depois de reconectar.

`COORD_CAPACITY_SCRIPT` é o caminho absoluto do script Node (padrão
`~/src/maestro-guard/capacity/capacity.mjs`), não uma linha de shell.
Executa `node <script> --json` sem shell, timeout 5s, cache de 30s (inclusive
falhas) e deduplicação de chamadas concorrentes. Só runtime e percentuais 5h/7d
validados são retornados. Falha resulta em `{ "status": "unavailable" }`;
janelas sem medição ou snapshots marcados `UNKNOWN` pelo produtor permanecem
`null`, nunca zero inventado nem percentuais antigos tratados como capacidade atual.
Contrato OpenAPI da rota: `coordination.openapi.json`, coberto por
`openapi-contract-api.test.js`. Fixtures dos testes são temporárias, sem ler
o estado real do Maestro. Nenhuma mudança é feita no produtor ou no script de capacidade.

## Versão (pin do Prisma)

A aba **Versão** lê `GET /api/version`: revisão em execução (HEAD de `PRISMA_ROOT`),
`origin/main` (depois de `git fetch`, cache de 60s; **Consultar origin** força) e os
commits entre elas. O Prisma não conhece o consumidor: a troca do pin roda comandos
que o consumidor declara no ambiente do dashboard:

| Variável | O que faz |
|---|---|
| `PRISMA_BUMP_COMMAND` | Linha de shell que recebe o SHA alvo como último argumento e move o pin (no app-back: `bash scripts/prisma-bump.sh`). Vazia = painel somente leitura. Roda com cwd no consumidor e `PRISMA_DASHBOARD_PID` no env. |
| `PRISMA_RESTART_COMMAND` | Opcional. Linha de shell que sobe o dashboard de novo (no app-back: `bash scripts/prisma-start.sh dashboard`). Sem ela, o painel avisa para reiniciar à mão. |

**Atualizar** (`POST /api/version/update` `{ target }`) só roda com o loop do watcher
parado, sem outro watcher na trava e sem agente destacado vivo (409 com o motivo),
um update por vez, e só para SHA que esteja na `origin/main`. Sucesso = comando com
exit 0 **e** `PRISMA_ROOT` no SHA alvo; só então, com `PRISMA_RESTART_COMMAND`, um
processo destacado espera este dashboard sair e sobe o novo (saída em
`dashboard/version-restart.log` do consumidor), e o atual encerra pelo mesmo caminho
do SIGTERM (que também para watcher e previews; se travar, sai em 15s). "Em execução" é a revisão do boot do processo; o HEAD em disco aparece à parte quando diverge (bump sem reinício), e aí nova atualização fica bloqueada até reiniciar. Falha devolve o erro e a saída saneada do bump e não reinicia nada.
As duas variáveis vêm do ambiente do processo (ou de `dashboard/.env`); o `.env` da raiz do consumidor não as fornece. No app-back, quem as exporta é `scripts/prisma-start.sh dashboard`.
Contrato: `version.openapi.json`, coberto por `openapi-contract-api.test.js`. Testes: `version-api.test.js` e o e2e da aba em `version-ui.test.js`.

## De onde vêm os runs

O watcher grava o estado das tasks no **worktree do ticket**
(`.claude/worktrees/<ticket>/memory/runs/<task-id>/`), não no `memory/runs` do checkout
principal. O dashboard lê os dois lugares. Como várias worktrees carregam cópias antigas
do mesmo run, cada task-id aparece uma vez só, e a cópia usada é:

1. a do worktree do próprio ticket (`<ticket>` = prefixo numérico do task-id), que é a
   que o watcher lê;
2. senão, a que tiver o `updated_at` mais recente.

O painel central mostra qual cópia está sendo exibida (`local`). `_archive/` e os
arquivos soltos (`*.log`, `watcher-state.json`) ficam de fora.

## Interface

- **Lista de runs** (esquerda): grupos **Precisa de você**, **Em andamento**, **Planejados
  e outros**, **Concluídos** (runs com `kind` `completed`/`has_pr`) e **Removidos da
  lista**. Todos recolhem com um clique e ficam como você deixou, inclusive depois de
  recarregar a página. Os três primeiros começam abertos e os outros fechados. **Recolher
  tudo**/**Expandir tudo** fica no topo da lista. Um pontinho azul no cabeçalho indica que
  o run aberto está num grupo recolhido. Na busca, os grupos com resultado abrem sozinhos
  e continuam recolhíveis. Cada linha mostra o número e o assunto do ticket, o próximo
  passo, há quanto tempo mudou, o badge do PR e se há mensagem na fila. A aba do navegador
  mostra quantos runs precisam de você. `/` busca e ↑/↓ troca de run.
- **Remover da lista (seleção múltipla):** clique em **Selecionar** (ou ⌘/Ctrl+clique num
  run). Shift+clique seleciona um intervalo, a caixa do grupo marca o grupo inteiro e
  Delete/Backspace remove. Depois de remover aparece **Desfazer**. Isso **só oculta** o
  run neste navegador (`localStorage`): o watcher e os arquivos em `memory/runs` não
  mudam. Os ocultos ficam em **Removidos da lista**, de onde dá para trazê-los de volta,
  e voltam sozinhos se o run tiver novidade (`updated_at` mais novo).
- **Trilho do ciclo:** Ticket → Plano → Implementação → Revisão → Testes → Verificação →
  Commit. Etapas feitas ficam verdes; a etapa atual (`state.node`, o próximo nó a rodar)
  fica azul pulsando, ou amarela/vermelha se o run estiver parado. Uma frase explica o
  estado em português e, quando o run está bloqueado, traz a última nota do agente.
  No celular o trilho fica na vertical.
- **Conversa com o agente:** suas mensagens e as notas do agente (`agent_log`) em ordem
  cronológica. Cada mensagem sua mostra **Na fila** até o watcher consumir e depois
  **Lida pelo agente há X min** (casada com `state.json.human_inputs`). Rascunhos não
  enviados ficam salvos por run. ⌘/Ctrl+Enter envia.
- **Ver context.md** (botão no topo do run): gaveta com o `context.md` inteiro
  (`GET /api/runs/:taskId/context`), em **Renderizado** (Markdown: títulos, listas,
  tabelas, código, links) ou **Texto**; o formato fica salvo no navegador. O conteúdo vem
  de agentes, então `public/markdown.js` escapa todo o texto (HTML cru aparece como
  texto), só gera links http(s)/mailto, sempre com `target="_blank" rel="noopener
  noreferrer"`, e imagem vira link. O `context_update` do WebSocket relê o arquivo sem
  perder a posição de leitura (quem está no fim continua no fim). A rota só lê o
  `context.md` da pasta do run: task-id inválido ou traversal dá 404 e symlink para
  fora da pasta conta como ausente. Run sem o arquivo (inclusive arquivado) mostra
  estado vazio.
- **Ticket Redmine** (seção recolhida no painel do run): ao expandir, busca
  `GET /api/runs/:taskId/ticket` uma vez por sessão e mostra título, status, responsável,
  estimativa, % concluído e o link para o ticket.
- **PR Matrix** (sempre visível no painel do run): uma linha por repositório de
  `state.pull_request` (`app-back`, `app-front`, ...), inclusive repo registrado sem
  URL/ID de PR, com o status (OPEN azul, MERGED verde, DECLINED vermelho, SUPERSEDED
  laranja), a **última checagem** (`last_checked_at`, gravado pelo polling de PRs do
  watcher) e o link direto. Ao abrir o run busca `GET /api/runs/:taskId/pr` e o estado
  real do Bitbucket (mais título, branches e aprovações) substitui o gravado; sem
  Bitbucket configurado ou fora do ar, a matrix fica com o último status do watcher.
  O resultado vale 60s; **↻ Atualizar** busca de novo na hora. Depois de buscar, os
  badges da lista ganham a cor do estado real.
- **PRs Inconsistentes** (banner, detectado no navegador): vermelho quando um repo está
  MERGED e outro DECLINED na mesma task (mesma regra que faz o watcher gravar o evento
  `escalation`); amarelo quando um está MERGED e outro ainda OPEN (merge parcial — ex:
  front em produção chamando endpoint do back ainda em branch). Repo único nunca alerta.
- Task com todos os PRs mergeados (`status: "fully_merged"`, gravado pelo watcher) conta
  como **Concluído**, igual a `committed`.
- **Contexto da tarefa:** o `context.md` como texto pré-formatado (monospace, sem parse),
  com uma divisória sutil entre seções `##` e as mensagens humanas destacadas. Mostra as
  últimas 100 linhas ou o arquivo todo e rola para o fim quando o arquivo muda. Sem
  `context.md`: "⏳ Aguardando primeiro nó — log aparecerá em breve" (ou "Sem
  context.md" para run concluído).
- **Alto risco** (`state.risk_level === "high"`, gravado pelo `/verify`, ver
  `memory/decisions/2026-09-22-pr-draft-high-risk.md`): badge vermelho `⚠ HIGH-RISK` ao
  lado do nome na lista, etiqueta `HIGH-RISK` sobre a estação **Commit** do trilho e o
  quadro **Motivo do risco** (`state.risk_reason`) logo abaixo da explicação do run.
  Sem o campo, ou com `"low"`, nada muda.
- **SPEC_CHANGE aguardando decisão** (`state.status === "spec-change-pending-approval"`: o
  /implement propôs mudar um requisito funcional, `scripts/lib/spec-change.js`): status
  `awaiting_approval`, e no detalhe o quadro com ACs afetados, comportamento de hoje e o
  proposto, motivo, e **Aprovar mudança** / **Rejeitar** (`POST /api/redmine/comment`
  com `action`; ficam desabilitados até o watcher publicar a proposta no ticket). Aprovada,
  o watcher atualiza a spec e devolve o run ao Plano; rejeitada, o run fica em
  `spec-change-rejected` (`needs_human_review`).
- **Tela desatualizada** (`public/state-version.js`, `docs/concurrency-map.md`): com um run
  aberto no detalhe, `GET /api/state/version?taskId=<id>` (só `{ state_version, node,
  execution_id }`) a cada 5 s. Se o servidor estiver à frente da versão carregada, aparece
  o banner não bloqueante "Este run mudou desde que a tela foi carregada. Atualize antes de
  executar esta ação." com **Atualizar**. As ações (QA retry, retomar sessão, replay,
  arquivar, aprovar/rejeitar) mandam o `casToken` carregado e um `operation_id`. Tela velha
  responde **409** `STATE_CONFLICT`/`SESSION_CONFLICT` com a mesma mensagem, nunca 500.
- **Spec aguardando aprovação** (`state.status === "spec-pending-approval"`: a spec estava
  incompleta e o watcher postou no ticket um draft, gerado por IA, das seções que faltam):
  status `awaiting_approval` (não conta como falha; entra em "Precisa de você"), badge
  amarelo `⏳ aguard. aprovação` ao lado do nome na lista e, no detalhe, o quadro do draft
  com **Ver draft** (`GET /spec-draft`, cada linha com `+ `) e **Aprovado** (confirma que o
  texto é de IA e foi revisado, depois `POST /api/redmine/comment`). O watcher junta o
  draft na spec no próximo tick.
  Vale também pra ticket que ainda **não tem task** (descrição rejeitada antes do
  `/fetch-ticket`, sem `state.json`): o dashboard lê a pendência de
  `memory/runs/<ticket>-spec-gate.json` e mostra um run sintético `<ticket>-spec-gate`, só
  leitura (sem conversa nem arquivar), com o mesmo badge e os mesmos botões. Ele some
  sozinho quando a pendência acaba ou quando o run de verdade do ticket aparece.
- **Transcrições** (terceira aba do painel "Contexto da tarefa", ao lado de `context.md`
  e **Timeline de Eventos**): uma linha por nó/tentativa de `state.transcripts[]` com
  status (**falhou** em vermelho / **sucesso**), tokens, tamanho e quando terminou.
  Clicar expande e busca `GET /api/runs/:taskId/transcript/:nodeId-:attempt` uma vez;
  mostra a conversa inteira do agente como tabela **role | conteúdo | timestamp**
  (`user`, `assistant` com `[thinking]`/`[tool_use …]`, `tool` para saída de ferramenta,
  `system`; mensagens de subagente trazem a origem). É a superfície principal de
  post-mortem para entender por que um nó falhou. O que está aberto continua aberto
  quando o run atualiza. Ver [Transcrições por nó](#transcrições-por-nó-post-mortem).
- Tema claro/escuro segue o sistema; o botão da lua força um dos dois.

## Transcrições por nó (post-mortem)

Toda vez que um agente despachado pelo watcher termina (sucesso **ou** falha), o watcher
copia a conversa completa da sessão para dentro da task. Isso roda no mesmo ponto que
fecha o `cost_tracking`: no exit com `--follow`, ou no tick seguinte sem ele.

- **Arquivo:** `memory/runs/<task-id>/transcripts/<nó>-<tentativa>.json`, ou `.json.gz`
  acima de `TRANSCRIPT_GZIP_THRESHOLD_BYTES` (padrão 102400; `0` nunca comprime).
  Formato `{ taskId, nodeId, attempt, metadata: { model, models, startedAt,
  finishedAt, tokenUsage, status: "success"|"failed", agent, sessionId, exitCode,
  partial, ... }, conversation: [{ role, content, timestamp, source? }] }`. Um despacho
  `fetch_ticket`+`plan` vira `plan-N` (com `alsoCovers: ["fetch_ticket"]`).
- **Fonte:** o transcript JSONL da sessão `claude -p --session-id` em
  `~/.claude/projects/` (principal + subagentes, intercalados por horário). Linha
  truncada é ignorada (`partial: true`, `skippedLines`). Sem transcript nenhum, grava a
  conversa vazia com `partial: true` e, em `--follow`, o stderr do processo.
- **Status:** `failed` se o exit code != 0, se houver erro de API no transcript, ou se
  `state.events` tiver `node_error`/`escalation` desse nó depois do despacho. `success`
  exige saída limpa. Sem evidência nenhuma, fica `failed` (e portanto retido).
- **state.json:** `transcripts: [{ nodeId, attempt, path, sizeBytes, compressed, status,
  tokenUsage, messages, finishedAt }]`, mais `transcripts_total` e
  `transcripts_size_bytes`. A cópia autoritativa é `transcripts/index.json`,
  reaplicada a cada gravação, para que um agente que regrave o `state.json` sem o campo
  não apague a lista.
- **Nunca derruba o ciclo:** qualquer exceção do writer vira log `[transcript] … (ciclo
  segue)`. `TRANSCRIPTS_DISABLED=true` desliga a captura.
- **Sensível:** prompt, diffs e saída de ferramenta. Fica só em disco local, nunca é
  enviado a serviço externo. Passa pela redação de secrets do watcher
  (`scripts/sanitize-log.js`) ao gravar e pelo `redact` do dashboard ao servir.
- **Sem task** (ex.: `fetch_ticket` travou antes de criar a task): vai para
  `memory/runs/_transcripts-unattributed/<ticket>/transcripts/`.

### Política de retenção

| Ciclo (`state.status`) | Transcrições |
|---|---|
| Bem-sucedido: `committed`, `fully_merged`, `completed` | Apagadas após **30 dias** (`TRANSCRIPTS_RETENTION_DAYS`), contados do `finishedAt` de cada uma |
| Com falha: `escalated`, `cancelled`, `state_corrupted`, `failed` | **Retidas indefinidamente** |
| Em andamento (qualquer outro status) ou sem `state.json` | Retidas |

A limpeza é um script separado, que o watcher **não** roda sozinho:

```bash
node scripts/cleanup-transcripts.js --dry-run   # mostra o que apagaria
node scripts/cleanup-transcripts.js             # apaga e reescreve index.json/state.json
```

O script varre `memory/runs/`, `memory/runs/_archive/` e `memory/archive/<YYYY-MM>/` do
checkout principal e de cada worktree. Ele pula arquivos versionados no git. Para rodar
todo dia, agende no cron, por exemplo `0 3 * * * cd <repo> && node scripts/cleanup-transcripts.js`.

## Atualizar e arquivar

- **↻ Atualizar** (topo, ou tecla `R`) recarrega a lista de runs e o contexto do run
  aberto, e consulta o Redmine e o Bitbucket de novo, sem recarregar a página. **Auto**
  atualiza sozinho a cada 30 s, 1, 5 ou 15 min, e a escolha fica salva neste navegador.
  No automático, Redmine e Bitbucket só entram se você marcar a opção, e mesmo assim no
  máximo a cada 5 min. Com a aba em segundo plano o automático pausa e, ao voltar, atualiza
  na hora. Mudanças em `state.json` e `context.md` continuam chegando ao vivo pelo WebSocket.
- **Arquivar** (botão no topo do run, ou **Arquivar (N)** na seleção múltipla) move a pasta
  do run para `memory/runs/_archive/` do mesmo checkout, igual ao `/commit`, e ela sai do
  dashboard. Antes de mover, pede confirmação e avisa quando algum run ainda está ativo:
  o watcher deixa de acompanhar, e se o ticket voltar para Aprovada/Recusa QA ele começa
  um ciclo novo. A API recusa arquivar um run ativo sem `force: true`.
  - Só a cópia que o dashboard mostra é movida. Cópias antigas do mesmo task-id em
    worktrees de outros tickets não são tocadas (evita deleções pendentes no git desses
    worktrees); elas ficam escondidas pelo registro `memory/runs/_archive/dashboard-archived.json`
    (não versionado) enquanto nenhuma for atualizada depois do arquivamento. Run que volta
    a andar reaparece sozinho.
  - Mover a pasta deixa uma mudança pendente no git daquele checkout (arquivos de
    `memory/runs` movidos). O dashboard não faz commit.
  - Logo depois aparece **Desfazer**. Os arquivados pelo dashboard ficam no grupo
    **Arquivados**, no fim da lista, com **Restaurar**. Runs arquivados pelo `/commit` não
    aparecem ali.
  - Diferente de **Só ocultar aqui**, que esconde neste navegador sem mexer em arquivos.
- API: `POST /api/runs/:taskId/archive` (`{ "force": true }` para run ativo; 409 sem),
  `GET /api/archive`, `POST /api/archive/:taskId/restore` (409 se já existe pasta no lugar
  original).

## Usar na minha máquina

No fold **Preview de Ambiente** do run, **💻 Usar na minha máquina** põe os checkouts
principais (este app-back e `../app-front`, `../app-core`, `../mo-entity`) no commit do
worktree do ticket, pra subir o ambiente de sempre (:8080/:9000) sem apagar o worktree.
Apagar o worktree leva junto `memory/runs/<task>` e o run some do dashboard.

- `git checkout <branch>` é recusado com a branch presa ao worktree, então cada repo vai
  pro `HEAD` do worktree em **detached** (`git switch --detach <sha>`). Commits novos se
  fazem no worktree; aqui é só pra rodar. Commit feito no worktree depois do clique não
  vem sozinho: clique de novo ("Atualizar pro último commit").
- Repo sem worktree do ticket não é tocado. Worktree com alteração não commitada gera
  aviso (ela não vem).
- Só `git switch`: suas alterações locais (ex.: `Gruntfile.js` do front) vão junto. Se o
  git recusar num repo, os já trocados voltam e nada muda (409 com o erro do git).
- **↩ Voltar às branches** devolve cada repo à ref de antes (guardada em
  `dashboard/local-checkout.json`, que sobrevive a restart). Repo cujo HEAD você mudou
  na mão desde então não é tocado.
- O `memory/` deste checkout (versionado) também passa a ser o do ticket até voltar.
  `scripts/` (no `.gitignore`) e `dashboard/` (não versionado) não mudam.
- Se o git recusar e algum repo também não conseguir voltar, o erro aparece no painel
  (fica visível, não só no toast) e esse repo entra no estado, pra o **Voltar** cuidar dele.
- API: `GET /api/local-checkout?ticket=<id>` (`{ active, repos }`),
  `POST /api/local-checkout/:ticketId/use`, `POST /api/local-checkout/restore`.
  Lógica em `scripts/local-checkout.js`.

## Retomar a partir de um nó (replay)

Run parado (committed, escalated, blocked, needs_human_review, pre-build-failed,
plan/churn-escalation, spec-invalid) mostra no detalhe o fold **Replay** com
"↩ Retomar a partir de" — só ficam habilitados os nós cujos anteriores o ciclo já
rodou. Retomar cria um run novo `<task-id>-replay-<n>` no **mesmo worktree**, copia os
artefatos do original menos os dos nós que vão rodar de novo, e re-despacha dali (CLI:
`node scripts/replay-cycle.js --task <id> --from <nó> [--dry-run]`; lógica em
`scripts/lib/cycle-replayer.js`). O `state.json` do original não é tocado — ao lado
dele fica `state-replay-<replay-id>.json`, e o watcher passa a ignorar o original como
task ativa. O run de replay mostra **Replay Info** (link pro original, nó de retomada,
quando); o original lista os replays que saíram dele.

## Arquivados com demanda aberta

O `/commit` arquiva o run ao terminar o ciclo, mas a demanda continua (PR aberto, ticket em
"Ag Merge", "Ag Teste" etc.). Esses runs voltam ao dashboard no grupo **Arquivados com
demanda aberta**, com o status do Redmine na linha e uma nota no painel do run.

- **Quem decide se a demanda terminou é o status do ticket no Redmine** (`is_closed`, ou o
  nome do status: concluído/encerrado/fechado/rejeitado/cancelado), não o `state.json`, que
  para todo arquivado diz `committed`. O ticket fechou, o run sai sozinho.
- O servidor varre `_archive/` de todos os checkouts ao iniciar, a cada 5 min e no botão
  **↻ Atualizar**. De cada ticket entra só o arquivado mais recente. Não entra quando o
  ticket já tem run ativo (o ativo já aparece) nem quando o run foi arquivado pelo próprio
  dashboard (você pediu para tirar).
- O status do ticket fica em cache: 5 min para ticket aberto, 1 h para fechado. Sem
  Redmine configurado não dá para saber, e nenhum arquivado entra.
- São só leitura: o watcher não lê runs em `_archive/`, então a API recusa mensagem (409)
  e arquivar de novo (409). Detalhe, contexto, Ticket Redmine e PR Matrix funcionam.
- Eles também aparecem nas abas (Quadro na coluna Concluído, Tabela, Tickets e PRs,
  Métricas), marcados com `archived: true` na API. `POST /api/archived-open/refresh`
  força a varredura.

## Navegação e atalhos

- **Visão geral** (tela inicial, sem run aberto): o que precisa de você, com a última nota
  do agente e os botões **Responder ao agente** (abre o run com o cursor no campo) e **Abrir
  run**; a atividade recente de todos os runs (despachos do agente e mensagens lidas); e
  os runs em andamento com o mini-trilho. **← Visão geral** no topo do run volta para cá.
- **Ir para… (⌘K / Ctrl+K):** busca qualquer run (número do ticket, assunto ou task-id,
  sem precisar de acento), visão ou ação: tema, recolher/expandir grupos, selecionar runs,
  consultar Redmine e Bitbucket, notificações, atalhos.
- **Link direto:** cada run tem URL própria (`#run/<task-id>`), que continua valendo depois
  de recarregar a página. No painel do run, **Copiar link** e o botão do task-id copiam
  para a área de transferência.
- **Atalhos:** `?` mostra a lista; `1`–`6` trocam de aba; `/` filtra; `↑`/`↓` (ou `j`/`k`)
  trocam de run; `⌘↵` envia; `Esc` fecha, limpa ou cancela.
- **Respostas rápidas** acima do campo de mensagem (Pode seguir, Explique antes, Rode os
  testes, Menor escopo, Pare aqui). Elas só preenchem o campo; nada é enviado sem clicar em
  **Enviar ao agente**.
- **Buscar no contexto:** o campo no painel do `context.md` destaca as ocorrências, mostra
  quantas são e carrega o arquivo todo ao buscar.
- **Notificações** (sino no topo, opcional): aviso do sistema quando um run parar
  esperando você enquanto a aba está em segundo plano. Clicar no aviso abre o run.
- **Mini-trilho** na lista: 7 pontos (feito em verde, atual em azul, parado em amarelo).
  O badge de PR fica neutro até o estado real ser conhecido.
- Passar o mouse sobre um tempo relativo ("há 2 horas") mostra a data e a hora exatas.

## Visões (abas no topo)

A busca do topo filtra todas as visões, e clicar num run em qualquer uma abre o painel dele
na aba **Runs**. A aba ativa fica na URL (`#quadro`, `#tabela`, `#timeline`, `#metricas`,
`#tickets`, `#grafo`) e no navegador.

- **Quadro:** uma coluna por etapa do ciclo, com um cartão por run na etapa que vai rodar
  em seguida. Os parados esperando você têm borda amarela e vêm primeiro. A coluna
  Concluído aparece com **Mostrar concluídos**.
- **Tabela:** todos os runs com ordenação por coluna (ticket, assunto, etapa, status, PR,
  tentativas, mensagens, iniciado, atualizado) e filtros de status, etapa, PR e "incluir
  removidos da lista".
- **Linha do tempo:** uma faixa por run nos últimos 7 dias, 30 dias ou tudo. Cada trecho vai
  de um despacho do agente ao seguinte (horários do `agent_log`), colorido pela fase:
  Preparação, Construção, Validação e Entrega. O tooltip traz a etapa exata e a duração. A
  faixa tracejada é o tempo esperando agora, em amarelo se estiver parado esperando você.
  As cores são uma rampa ordinal de um só matiz, validada nos dois temas. Sete etapas não
  cabem distinguíveis num matiz, por isso a divisão em fases.
- **Métricas:** contadores por status, runs ativos por etapa, mediana do tempo por etapa
  (estimada pelo `agent_log`), retrabalho (`state.retries`) e PRs por estado (real do
  Bitbucket onde já foi consultado; senão, o do `state.json`).
- **Tickets e PRs:** um cartão por ticket do Redmine, com status, responsável, % e
  estimativa; os PRs do Bitbucket por repositório, com estado real e aprovações; e os runs
  do agente. Ao abrir a aba (ou em **↻ Atualizar**), busca Redmine e Bitbucket em lote,
  4 requisições por vez, com os mesmos proxies e caches do painel do run e sem polling.
  **Alertas** apontam quando os três não batem: PR recusado, ticket encerrado com run
  ativo, todos os PRs mergeados com ticket ainda aberto, PR aberto há mais de 7 dias sem
  aprovação. Os cartões com alerta vêm primeiro. Há filtros para com alerta, PR aberto e
  sem PR. Runs cujo task-id começa com data, e não com o número do ticket, ficam em "Sem
  ticket".
- **Grafo:** rastreabilidade ticket → spec → arquivos → PR, lida de
  `memory/knowledge-graph.json` (`GET /api/graph`; gravado pelo watcher a cada tick e pelo
  `/commit` — ver `scripts/lib/knowledge-graph.js`). Um cartão por ticket com a spec, os
  arquivos tocados agrupados por repositório (`.java` primeiro) e os PRs com o status do
  polling. O campo de busca aceita número do ticket (`43425`, `TASK-43425`, task-id) ou
  caminho/nome de arquivo; clicar num arquivo lista todos os tickets que o tocaram, clicar
  no número recorta o ticket. Não é ao vivo: **↻ Atualizar** relê o arquivo. Na linha de
  comando, o mesmo com fallback no `git log`: `node scripts/trace.js <arquivo>`.

Tudo chega via WebSocket (chokidar observando `state.json`, `context.md` e
`human-input.md`), sem polling. Se a conexão cair, o cliente reconecta com backoff
exponencial (1s → 30s) e mostra a contagem regressiva. Worktrees novas entram sozinhas
em até 10s.

## Ativos x concluídos (`kind`)

`GET /api/runs` inclui `kind` e `pr_url` (URL do primeiro PR, app-back primeiro):

| `kind` | Quando |
|--------|--------|
| `active` | `in_progress`/`running`/`blocked`/`escalated`/`needs_human_review`/`spec-pending-approval`/`spec-change-pending-approval`/`spec-change-rejected`, **mesmo com PR**, ou status não terminal sem PR (ex.: `planned`) |
| `failed` | `failed`/`spec-invalid` |
| `has_pr` | status terminal (ex.: `committed`) com `pull_request` |
| `completed` | `committed`/`done`/`closed`/`archived` sem PR |
| `unknown` | sem `state.json` legível (aparece em Ativos) |

A diferença para "tem PR ⇒ concluído" é proposital: o #43452 está bloqueado com PR de
front aberto e, com essa regra, sumiria dentro de Concluídos enquanto espera você.

`state.pull_request` aparece em vários formatos nos runs reais, e todos são aceitos:
mapa por repositório (`{ "app-back": { url, id } }`, o do schema), valor string com a
URL, `pr_url` no lugar de `url`, `{ id, links.html.href }` (Bitbucket) e `{ url, number }`.
Só URLs `http(s)` viram link.

## Canal humano→agente

1. O chat faz `POST /api/runs/:taskId/message`, que **appenda** um bloco
   `## Human input — <ISO>` em `<task dir>/human-input.md`. Várias mensagens antes do
   watcher passar não se perdem.
2. Logo antes de despachar o próximo segmento daquela task (entre dois nós), o watcher
   chama `checkHumanInput()`, que:
   - appenda o conteúdo ao `context.md`, entre `---`;
   - registra em `state.json.human_inputs[]` (`timestamp`, `content`);
   - move o texto para `human-input.processed.md` (acumulativo);
   - injeta o texto também no prompt do despacho, porque o `/plan` reescreve o
     `context.md` e poderia apagar o append.
3. É best-effort. Se o watcher morrer antes, o arquivo continua lá e é lido no próximo
   despacho. Task `blocked`/`escalated`/`spec-invalid` não é despachada, então a
   mensagem fica pendente até ela voltar a andar. O dashboard não muda o status de
   nenhuma task.

Sem `--follow`, "entre nós" quer dizer a cada tick do watcher. Com `--follow`, quer dizer
entre cada segmento encadeado.

## Controle do watcher

O indicador **Watcher** no topo (bolinha verde = ativo, vermelha = parado, amarela =
iniciando/parando/reiniciando) abre o painel com Start/Stop/Restart, PID, uptime,
reinícios automáticos, a task em andamento (com **Ver run atual**) e o log em tempo real.
Por baixo, é `scripts/watcher-manager.js`:

- **Laço de ticks.** Sem `--follow`, `readmine-watcher.js` roda um tick e sai com 0 (foi
  feito pra cron). O manager dispara um tick e, quando ele sai limpo, agenda o próximo
  depois de `WATCHER_TICK_INTERVAL_MS`. Entre ticks não há processo: `running: true`
  com `pid: null` é o normal. O comportamento do watcher não muda.
- **Crash** (código ≠ 0 ou sinal, sem ter sido pedido pelo Stop): espera 3s e reinicia
  ("reiniciando automaticamente... tentativa N/3"). No máximo 3 reinícios por hora:
  no 4º crash o laço para, `status.error = "restart_limit_reached"` e o indicador fica
  vermelho com ⚠ até alguém clicar Start (o Start manual zera a contagem).
- **Stop:** SIGTERM, espera até 5s, depois SIGKILL. Agentes que um tick já despachou
  são detached e continuam rodando: o Stop não mexe neles.
- **Nunca sobe sozinho**, a não ser que você marque "Iniciar automaticamente quando o
  dashboard subir" (fica em `dashboard/dashboard-prefs.json`). Ctrl+C/SIGTERM no
  dashboard para o watcher antes de sair.
- **Env:** o filho herda o env inteiro do dashboard (incluindo o que veio do
  `dashboard/.env`, que tem prioridade) e ainda lê o `.env` do repo pro que faltar.
- **Órfão:** o PID do tick corrente fica em `dashboard/watcher.pid`. Se o dashboard morrer
  no meio de um tick, na próxima subida o painel avisa, e o Start encerra o órfão antes
  de disparar um novo.
- **Log:** ringbuffer das últimas 200 linhas de stdout+stderr (stdout vira INFO; stderr
  vira ERROR quando fala de erro/falha, senão WARN; linhas do próprio manager aparecem
  em negrito). Antes de entrar no buffer, cada linha passa por `scripts/sanitize-log.js`:
  valores de `BITBUCKET_API_TOKEN`, `REDMINE_API_KEY` e de qualquer
  `*_TOKEN|*_API_KEY|*_SECRET|*_PASSWORD` (do env e do `.env` do repo) viram
  `[REDACTED]`, e o mesmo vale pra atribuições `CHAVE=valor` e headers
  `Authorization`/`X-Redmine-API-Key`. O log não é gravado em disco. **Limpar** e os
  filtros INFO/WARN/ERROR só mexem na tela.
- **Histórico:** start/stop/crash vão para `dashboard/watcher-history.json` (últimos 200
  eventos, sem conteúdo de log), que alimenta "Última execução: … · parou às …".

`watcher.pid`, `watcher-history.json` e `dashboard-prefs.json` estão no `.gitignore`.

## API

| Método | Rota | Retorno |
|--------|------|---------|
| GET  | `/api/runs` | Lista resumida (status, nó, grafo, `state` redigido). |
| GET  | `/api/runs/:taskId` | Resumo + `state` + `context` (context.md completo). |
| GET  | `/api/runs/:taskId/transcript/:nodeId` | Transcrição do nó (aba **Transcrições**): `:nodeId` = `verify` (última tentativa, ou `?attempt=N`) ou `verify-2`. `{ taskId, nodeId, attempt, attempts[], path, sizeBytes, metadata, conversation: [{ role, content, timestamp }] }`, lê `.json` ou `.json.gz`, redigido. Lista de `state.transcripts[]` (fallback `transcripts/index.json`). 404 sem transcrição/run, 400 `nodeId` ou `path` inválido. |
| GET  | `/api/runs/:taskId/log?lines=N` | Últimas N linhas do context.md (padrão 100, máx 5000). |
| POST | `/api/runs/:taskId/message` | `{ "message": "..." }`, appenda em human-input.md. |
| POST | `/api/runs/:taskId/retry-qa-rejection` | Botão "🔄 Corrigir recusa QA". Só com o ticket em Recusa QA (`demand.status` do arquivado ou `state.ticket_status`; senão 400). Busca a última nota nos journals (falha => "(sem nota registrada)", segue), move o ticket pra "Em Desenvolvimento" (PUT + releitura; não aplicou => 502 e nada local é escrito), appenda o bloco "## Recusa QA — Correção Solicitada" no context.md, grava `qa_rejection`/`qa_retry_count`/`node=implement`/`status=in_progress` e `retry-signal.json`. O watcher consome o sinal: recria o worktree se preciso, traz o run de volta pra `<worktree>/memory/runs/` (mesmo task-id) e despacha o implement. `200 { ok, note, qa_retry_count, ticket_status }`; 409 nó rodando / retry já pedido. O resumo traz `ticketStatus`, `qaRejected`, `qaRetryCount`, `qaRetryPending`. |
| POST | `/api/runs/:taskId/replay` | `{ "fromNode": "plan\|implement\|review\|test\|verify\|commit" }`. Roda `scripts/replay-cycle.js --task <taskId> --from <nó> --json` e devolve `201 { ok, replayTaskId, fromNode, nodesToRun, removed, redmine, dispatched, warnings }`. 400 nó inválido, 409 run andando / nó cujos anteriores nunca rodaram / recusa do script (`code`: `worktree_missing`, `active_cycle`...), 404 run desconhecido. O resumo de todo run traz `replay: { replayable, reason, nodes }`. |
| GET  | `/api/runs/:taskId/ticket` | Proxy do Redmine: `id, subject, status, assigned_to, tracker, priority, estimated_hours, done_ratio, updated_on, url`. 404 sem ticket, 503 não configurado, 502 Redmine fora. |
| GET  | `/api/runs/:taskId/pr` | Proxy do Bitbucket: `{ prs: [{ repo, id, title, state, author, created_on, updated_on, url, source, destination, reviewers, participants (aprovaram), local_state, status, last_checked_at, error? }], fetched_at }`. Um item por repositório de `state.pull_request` (repo sem URL/ID vem com `error`); `status`/`last_checked_at` são os gravados pelo polling do watcher; erro por PR fica no item. 404 sem PR, 503 sem token, 422 sem número de PR. |
| POST | `/api/pr/:ticketId/ready` | "Marcar como pronto" do painel de preview: tira de Draft (Bitbucket `PUT .../pullrequests/{id}` com `draft: false`) todos os PRs de `state.pull_request` e grava `pr_status: "ready"`. Body opcional `{ taskId }` (run aberto); sem ele, `:ticketId` é o task-id ou o número do ticket (run mais recente dele com PR). `{ ok: true }`; 502 `{ error }` se algum PR falhou (pr_status fica `draft`), 409 se já mergeado ou chamada em andamento, 422 sem PR, 503 sem token. O token só vai no header. |
| GET  | `/api/runs/:taskId/spec-draft` | Draft da spec de um run `spec-pending-approval`: `{ taskId, draft_path, content (redigido), posted_at, comment_id, reminder_sent, missing_sections, keyword }`. 409 em outro status, 400 se `draft_path` não for `memory/spec/*.draft.md` dentro do repo, 404 sem arquivo. |
| POST | `/api/redmine/comment` | `{ "taskId": "...", "action"?: "approve" \| "reject" }` (não aceita texto). Posta no ticket a nota `<SPEC_APPROVAL_KEYWORD>` (ou `<SPEC_REJECTION_KEYWORD>` com `reject`) + linha fixa de origem; `{ ok, ticketId, action }`. 404 run/ticket, 409 fora de `spec-pending-approval`/`spec-draft`/`spec-change-pending-approval`, `reject` fora de SPEC_CHANGE, ou SPEC_CHANGE ainda não publicada pelo watcher; 503 Redmine não configurado, 502 Redmine fora. |
| GET  | `/api/runs/:taskId/screenshots` | `{ screenshots: [{ filename, size, mtime }] }` de `memory/runs/<taskId>/screenshots/` (só `.png/.jpg/.jpeg/.webp` regulares, sem symlink). Sem diretório (ou run desconhecido) => lista vazia. |
| GET  | `/api/runs/:taskId/screenshots/:filename` | Serve a imagem com o Content-Type da extensão. Nome fora de `^[\w-]+\.(png\|jpg\|jpeg\|webp)$` ou com `../` => 400; inexistente => 404. |
| GET  | `/api/graph?taskId=&file=` | Knowledge Graph: `{ version, updatedAt, exists, filter, nodes, edges, tickets: [{ id, title, redmine_url, specs[], files[], prs[] }] }`. Sem filtro, tudo; `taskId` (`43425`, `TASK-43425` ou task-id) recorta o ticket; `file` (caminho ou só o nome) devolve os tickets que tocaram o arquivo. Redigido. 500 se o JSON estiver malformado. |
| GET  | `/api/watcher/status` | `{ running, state (stopped\|running\|restarting\|stopping), pid, uptime_ms, restarts, restarts_last_hour, max_restarts_per_hour, error, phase (tick\|idle), tick_started_at, next_tick_at, interval_ms, ticks, orphan_pid, last_run }`. |
| POST | `/api/watcher/start` · `/stop` · `/restart` | Executa e devolve o status. `stop` volta depois que o processo saiu (≤ 5s + SIGKILL). |
| GET  | `/api/watcher/log-stream` | SSE: `event: hello` `{ instance }`, depois o buffer inteiro e uma mensagem `data: { seq, ts, level, source, text }` por linha nova; `: ping` a cada 15s. |
| GET/PUT | `/api/watcher/prefs` | `{ auto_start: boolean }`. |
| GET  | `/api/validate-config` | Painel **Saúde do Sistema** (🔧 no topo): roda `scripts/validate-config.js --format json` (só leitura, nunca `--fix`) e devolve o relatório `{ contractVersion, valid, exitCode, message, summary: { errors, warnings, info, rules, passedRules }, results: [{ rule, severity, passed, message, details? }] }`. Exit 1 do script continua 200 com `exitCode: 1` — é o que acende o alerta **⚠ Erros de Configuração** no topo. 500 se o validador não rodou. |
| GET  | `/api/status` | Saúde: `{ uptime_ms, ws_clients, last_file_change, runs_tracked }`. Único endpoint fora do filtro de localhost (só contadores). |
| GET  | `/api/coordination` | Estado v1 validado de frentes/tarefas e capacidade; `empty`/`invalid` explícitos. Read-only. Contrato adjacente `coordination.openapi.json`. |
| GET  | `/api/version` | Pin do Prisma: `{ status, current, latest, behind[], behind_truncated, fetched_at, fetch_error, update: { configured, enabled, reason, restart }, last_update }`. `?refresh=1` refaz o fetch. |
| POST | `/api/version/update` | `{ target: <sha40> }`: roda `PRISMA_BUMP_COMMAND` e, se houver, reinicia via `PRISMA_RESTART_COMMAND`. 400 SHA inválido, 409 travado/fora da main/já na revisão, 500 bump falhou. |

Eventos WebSocket: `hello` (lista inicial), `state_update` `{ taskId, state, run }`,
`context_update`, `human_input`, `runs_changed`, `coordination_update`.

## Segurança (dev tool local)

- Escuta só em `127.0.0.1`. Requisições HTTP/WS com `Host` ou `Origin` que não sejam
  localhost levam 403, o que bloqueia DNS rebinding e páginas de terceiros.
- Só lê e escreve dentro de diretórios `memory/runs/<task-id>/`. O `task-id` é validado
  (`[A-Za-z0-9._-]`, sem `..`) e precisa ser um run que existe.
- Do `.env` do repo lê só as 5 chaves de integração. `REDMINE_API_KEY` e
  `BITBUCKET_API_TOKEN` só saem do processo como header da chamada para o Redmine
  (`X-Redmine-API-Key`) ou para o Bitbucket (`Authorization: Bearer`). Nunca vão em URL,
  log, resposta ou no JS da página. Os logs de erro mostram só o status (`HTTP 404`,
  `tempo esgotado`). As respostas passam por redação: chaves de JSON e
  atribuições `*_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD`, headers `X-Redmine-API-Key` e
  `Authorization`, e qualquer valor de env secreta do próprio processo viram `***`.
