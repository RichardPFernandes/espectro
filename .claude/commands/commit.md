---
description: Nó "Commit" — único nó autorizado a escrever permanentemente em memory/spec e decisions/.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Task-id: $ARGUMENTS

Você está executando o nó **Commit**, o único nó do grafo com permissão de escrita
permanente em `memory/`.

> Nota: desde 2026-09-02 (pedido explícito do usuário: "quero que dispare sim
> o /commit"), o watcher passa a despachar este nó automaticamente assim que
> `verify` passa, igual a qualquer outro — não há checkpoint humano manual
> obrigatório antes do commit/push/PR/Redmine (ver
> `memory/decisions/2026-09-02-commit-automatico.md`).

## Passos obrigatórios
0. **Transição de contrato pendente** (Dependency Invalidation — `docs/dependency-invalidation.md`):
   `node "$PRISMA_ROOT/scripts/invalidate.js" guard memory/runs/$ARGUMENTS --phase=commit`. Exit 1 =
   `PENDING_SPEC_INVALIDATION`: uma SPEC_CHANGE aprovada chegou depois do Verify e os
   artefatos ainda não foram reavaliados contra a spec nova. **Pare**, sem commit, sem
   mexer em `memory/` e sem mexer em `node`/`status` — o watcher aplica a invalidação e
   devolve a task ao `/plan`.
1. Releia `context.md` da task inteira (diagnóstico → implementação → revisões →
   testes → verificação).
2. Atualize `memory/spec/*.md` relevante — ADITIVO. Nunca reescreva um parágrafo já
   existente sem deixar rastro; se algo que a doc dizia ficou errado, acrescente uma
   nota de correção com data, não apague o texto anterior.
   **Exceção única:** a seção `## Decisões de Implementação` da spec da task é
   escrita pelo `/implement` durante o ciclo (APPEND, formato em
   `templates/spec-decisions-section.md`). Preserve-a como está — não a resuma,
   não a mova, não a apague ao arquivar a task. Se alguma decisão dela mudou um
   critério de aceite, é aqui que a spec ganha a nota de correção datada no
   critério correspondente — como **sub-item indentado** debaixo do `AC-XX`, nunca
   como item novo no nível dos critérios, e sem trocar, renumerar ou apagar ID
   (critério que deixou de valer: `AC-XX: (removido em <data>: motivo) <texto>`).
   IDs AC-XX são estáveis: o registro de ACs e o `state.json.ac_ids` apontam pra eles.
2.5. **Doc por classe** (ver `memory/spec/index.yaml` do consumidor e os exemplos
   de formato nele referenciados quando criar uma subseção `## Classe:` nova). Se a classe/
   service tocado por esta tarefa bater um dos 3 critérios abaixo, crie ou
   atualize a subseção `## Classe: <Nome>` dela dentro do arquivo de spec do
   módulo (`spec/04-logica-de-negocio/<modulo>.md`) — nunca um arquivo novo por
   classe, pra não inflar `index.yaml` com uma entrada por classe:
   1. Está coberta por uma regra inviolável em `project.yaml`.
   2. Reapareceu em 2+ rodadas de recusa QA ou 2+ tickets distintos
      (`grep -l '<Classe>' memory/decisions/*.md memory/runs/*/state.json
      memory/runs/_archive/*/state.json`) — sinal de que a lógica confunde
      gente nova toda vez.
   3. Tem lógica não-óbvia (backtracking, fallback, roteirização, ordem de
      precedência que não é visível sem ler o código inteiro) que vale
      documentar o "porquê", não só o "o quê".

   Fora isso, o módulo fica só no nível atual (visão geral), sem subseção por
   classe — não vale o custo de manutenção. A subseção cobre: responsabilidade,
   invariantes que não podem quebrar (extraídas do código real lido nesta
   sessão, nunca inventadas), e link pras `decisions/` relevantes sem duplicar
   o conteúdo delas. Se a subseção já existir e a tarefa mudou comportamento
   dela, atualize como qualquer doc ADITIVO (passo 2): acrescente nota com
   data, não apague o que ficou incorreto sem rastro.
3. Se o status do módulo tocado mudou (`planejado` / `em_construcao` / `pronto`),
   atualize o campo `status` dele em `memory/spec/index.yaml`. Não existe
   arquivo de status centralizado (ver
   `memory/decisions/2026-09-29-remocao-status-yaml.md`); o estado da task vive
   só em `memory/runs/<task-id>/state.json` (passo 9).
4. Se a tarefa envolveu uma decisão de design não óbvia, crie um arquivo novo em
   `memory/decisions/AAAA-MM-DD-titulo-curto.md`.
5. Se `memory/spec/index.yaml` precisa de entrada nova (módulo novo, arquivo novo),
   atualize.
6. **Antes do `git commit`, repita o passo 0** (a transição pode ter chegado durante os
   passos 1–5): exit 1 = pare sem commitar. Depois do commit, uma transição nova vale para
   o próximo ciclo (o run já entregou contra a spec que o governou).
   Faça o commit git real — só a mudança de código. **Mensagem com a versão da spec**
   (run versionado): monte a mensagem no padrão do repo (`<id do ticket> - <título>`) e
   passe por `node "$PRISMA_ROOT/scripts/lib/spec-version.js" commit-message memory/runs/<task-id> "<mensagem>"`,
   que devolve `43670 - Título [spec_version=2]` (run legado ou spec não selada: a
   mensagem volta intacta). Use a saída literal no `git commit -m`, também nos repos
   irmãos (passo 6.5). `memory/` é LOCAL (está no
   `.gitignore` e fora do índice desde 2026-09-23): nunca faça `git add memory`,
   `git add -f memory/...` nem `git add -A` que a arraste. Antes de commitar, confira
   `git diff --cached --name-only | grep '^memory/'` — tem que sair vazio.
6.5. **Commit dos repos relacionados tocados**: use somente os worktrees/repos
   explícitos no Plan e na configuração do consumidor. Não inferir siblings pela
   presença de diretórios. Preserve mudanças alheias; cada commit leva só o delta
   da task. Registros do ciclo continuam no consumidor que detém o subject.
7. **Push + abertura de PR** (habilitado desde 2026-09-02, ver
   `memory/decisions/2026-09-02-push-pr-automatico.md` e `2026-09-02-push-pr-
   siblings.md`). Repita para o consumidor **e cada repo relacionado commitado no passo6.5**,
   usando os nomes/remotes/branches explícitos de cada repo:
   - Confirme que `BITBUCKET_EMAIL`, `BITBUCKET_API_TOKEN` e
     `BITBUCKET_WORKSPACE` estão no ambiente (checagem de presença sem imprimir
     valores — são as credenciais de API token da Atlassian, não App
     Password: usuário = e-mail, senha = o token). Se qualquer uma faltar,
     **pare aqui, não dê push em nenhum repo** — avise o usuário que faltou
     configurar e continue o resto do fluxo (git commit local já feito em
     todos, cada um fica pronto pra push/PR manual).
   - Push com `scripts/git-push-effect.sh` (asset de plataforma). O watcher
     exporta `DOM06_ATTEMPT_FILE` no ambiente do nó. Sem Attempt admitido o
     script sai 1 e **não** chama `git push`. Repetir o mesmo push no mesmo
     Attempt não faz um segundo push.
     ```
     "$PRISMA_ROOT/scripts/git-push-effect.sh" push -u origin <branch>
     ```
     (branch = mesmo nome do ticket, já em uso em todos os repos tocados).
   - Monte o título do PR a partir de `state.json.redmine_ticket`, no formato
     `<tracker> #<id> - <subject>` (ex: `Problema #43425 - Correção do comportamento informado`) — literal, sem sufixos, sem reformatar
     o assunto. **Mesmo título em todos os repos** — é a mesma demanda.
   - Abra o PR usando **sempre** `scripts/bitbucket-open-pr.sh` (asset de plataforma indicado por PRISMA_ROOT) — nunca remonte o `curl` na mão de novo. É o mesmo request
     testado e validado ao vivo (ticket #43509, 2026-09-11: `Authorization:
     Bearer $BITBUCKET_API_TOKEN`, API token `ATATT...`, não Basic Auth —
     Basic pode dar 401/403 dependendo do endpoint). Foi justamente remontar
     esse curl à mão numa sessão anterior que gerou um diagnóstico errado de
     "token inválido/expirado" quando o token estava (e está) válido. O script
     também põe os default reviewers do repo no PR (a API não faz isso sozinha) —
     confira a linha `Reviewers:` no stderr; `nenhum` + `WARN` = avise no handoff. Uso:
     ```
     "$PRISMA_ROOT/scripts/bitbucket-open-pr.sh" <repo> <branch-do-ticket> \
       <state.json.redmine_ticket.base_branch> "<título>" <<'EOF'
     <descrição curta, resumo do context.md>
     EOF
     ```
     **Versão da spec no PR** (run versionado): o título continua literal (sem sufixo);
     a **primeira linha da descrição** é a saída de
     `node "$PRISMA_ROOT/scripts/lib/spec-version.js" pr-line memory/runs/<task-id>`
     (`Spec: memory/spec/<id>-spec.md · spec_version=N · spec_hash=<12>`; exit 1 = run
     legado, sem linha). Com `[WARN] SPEC_CHANGE_MID_RUN` em
     `state.json.spec_conformance.warnings`, cite-o logo abaixo dessa linha.
     **PR de alto risco** (desde 2026-09-22; a decision
     `2026-09-22-pr-draft-high-risk.md` citada no histórico não existe nesta
     `memory/` — as regras abaixo são autocontidas, não tente abri-la): leia
     `state.json.risk_level` (gravado pelo `/verify`, passo 4).
     - `"high"`: chame o script com `--draft --title-prefix "HIGH-RISK"` (o
       script monta `[HIGH-RISK] <título>` — não prefixe o título você mesmo) e
       comece a descrição com este bloco, **antes** do resumo do context.md,
       com `Motivo:` = `state.json.risk_reason` literal:
       ```
       scripts/bitbucket-open-pr.sh --draft --title-prefix "HIGH-RISK" \
         <repo> <branch-do-ticket> <base_branch> "<título>" <<'EOF'
       ⚠️ HIGH-RISK — revisão redobrada necessária antes do merge
       Motivo: <state.json.risk_reason>
       Critério: regra inviolável (ver memory/project.yaml > regras_invioláveis)

       ---

       <descrição curta, resumo do context.md>
       EOF
       ```
       Vale pra todos os repos da task (mesmo título, mesmo aviso). Push, commit,
       status Redmine e o resto deste passo seguem exatamente iguais.
     - `"low"` ou campo ausente (task anterior a 2026-09-22): uso normal acima,
       sem prefixo, sem bloco de aviso.

     **ACs não automatizados**: se `state.json.spec_conformance.acceptance.not_automated`
     não estiver vazio, termine a descrição (qualquer risk_level) com o bloco abaixo,
     uma linha por AC, justificativa literal de `acceptance-evidence.json >
     coverage.<AC>.justification` — é o que o dev valida à mão no preview:
     ```
     ### Validação manual pendente
     - AC-03 (NOT_AUTOMATED): <justification>
     ```

     **Todo PR abre como Draft** (desde 2026-09-24, qualquer risk_level): o script
     já manda `"draft": true` por padrão — não passe `--no-draft`. O dev testa no
     preview de ambiente do dashboard e marca como pronto por lá ("Marcar como
     pronto" → `POST /api/pr/<ticket>/ready`). Os worktrees do ticket são
     removidos pelo watcher logo depois deste nó (passo 7.6) — não no merge.

     `<repo>` = slug explícito do repositório configurado. `destination` = mesma base em todos, salvo o
     repo irmão ter convenção de branch base diferente — confira o workflow
     dele antes de assumir. O script já lê `BITBUCKET_WORKSPACE`/
     `BITBUCKET_API_TOKEN` do ambiente, nunca loga o token, e imprime a URL
     do PR em stdout (capture com `$(...)`) — em erro, sai com código 1 e a
     mensagem da API em stderr.
   - Grave (sempre por `node "$PRISMA_ROOT/scripts/state-writer.js" set memory/runs/<task-id> --input=<patch.json>`) a URL retornada em `state.json.pull_request` — se mais de um repo,
     vira um objeto por repo (`{"projeto": {...}, "biblioteca": {...}}`), não
     só a última sobrescrevendo a anterior. Em run versionado, cada entrada leva também
     `spec_version` e `spec_hash` (= `state.json.spec.version`/`spec.hash` no momento do
     PR) — é o dado da aresta PR→SpecVersion do knowledge graph. Grave também, na raiz do state.json,
     `"pr_status": "draft"` e `"pr_id"` = número do PR do consumidor principal (ou primeiro repo pertinente) — é o que o painel de preview usa pro badge.
   - Se o PR abriu com sucesso e a task tem `state.json.redmine_ticket.id`
     (veio de `/fetch-ticket`): mova o ticket Redmine pro status **"Ag
     Merge"** (id 20) pelo efeito governado, não pelo MCP:
     ```
     node "$PRISMA_ROOT/scripts/lib/dom06-attempt.js" redmine-effect \
       --attempt "$DOM06_ATTEMPT_FILE" --obligation redmine_status \
       --url "$REDMINE_URL/issues/<id>.json" --method PUT <<'EOF'
     {"issue":{"status_id":20}}
     EOF
     ```
     Exit 3 = autoridade recusada ou revogada: pare, sem retry. Exit 0 com
     `DUPLICATE` = a mesma nota/status já foi aplicada neste Attempt. Só
     faça isso se o PR realmente abriu — não mova o status se o push/PR foi
     pulado por falta de credencial. **Achado ao vivo (ticket #43425):** essa
     transição de status pode exigir campo customizado obrigatório que não é
     óbvio pelo nome (ex: "Necessita Lib. Plano", id 7, exigido pelo workflow
     do Redmine ao entrar em "Ag Merge" mesmo sem relação aparente com PR) —
     se a chamada retornar 422 com `errors`, releia a mensagem, preencha o(s)
     campo(s) apontado(s) (default seguro quando ambíguo: `"0"`, mesmo padrão
     booleano de "Hora Extra?"/"Recusa QA" neste projeto) e tente de novo. Não
     é motivo pra desistir da transição.
7.5. **Rastreabilidade `@spec` + Knowledge Graph** (desde 2026-09-24). Objetivo: dado
   um bug em produção num `.java`, conseguir voltar ao ticket/spec/PR que o mudou
   (`node "$PRISMA_ROOT/scripts/trace.js" <arquivo>`). Rode da raiz do worktree do ticket, **depois**
   de gravar `state.json.pull_request` (o comentário leva o número do PR):
   - `node "$PRISMA_ROOT/scripts/lib/knowledge-graph.js" annotate <task-id> --dry-run` e confira a
     lista; depois sem `--dry-run`. O script insere no topo de cada `.java`
     **criado** ou com **mais de 20 linhas mudadas** (adições+remoções vs merge-base)
     na branch, em app-back e em cada repo irmão que tem PR em `pull_request`:
     ```java
     // @spec memory/spec/<ticket>-spec.md | redmine:#<ticket> | pr:PR-<repo>-<n>
     ```
     Se o arquivo já tiver `@spec` de run anterior, a linha nova entra logo abaixo
     das existentes (nunca substitui). Só `.java` — nunca XML, properties, SQL, JS.
     Não escreva essas linhas à mão: é o script que decide o que é "significativo"
     e lê task-id/ticket/PR do `state.json`.
   - Em cada repo onde o script anotou algo: commit separado só com esses arquivos
     (`git add <arquivos listados>`; mensagem `<id do ticket> - rastreabilidade @spec`)
     e o push seguinte também passa por `git-push-effect.sh` na mesma branch — o PR aberto no passo 7 recebe o commit sozinho.
     Confira `git diff --cached --name-only` antes: só os `.java` anotados.
   - `node "$PRISMA_ROOT/scripts/lib/knowledge-graph.js" record <task-id>` — grava em
     `memory/knowledge-graph.json` (checkout principal, local) os nós do ticket,
     spec, PRs e arquivos tocados. Append-only; pode rodar quantas vezes quiser.
   - Falha em qualquer um destes (exit ≠ 0): avise e siga o fluxo — não bloqueia
     o commit/PR já feitos. Sem PR aberto (passo 7 pulado): pule o `annotate` (não há
     número de PR pra referenciar), mas rode o `record` mesmo assim.
7.6. **Limpeza de worktrees** (desde 2026-09-29) — **quem faz é o watcher, não você.**
   Este nó roda dentro do worktree do ticket e ainda grava nele (passo 8, arquivamento
   do run em `memory/runs/_archive/`): **não rode `git worktree remove`** aqui. Depois
   que o `/commit` sai com `status: "committed"`, o watcher
   (`scripts/readmine-watcher.js > cleanupWorktreesAfterPrOpen`, a cada tick) faz, pra
   toda task com URL em `state.json.pull_request`:
   - copia os runs do worktree pro `memory/runs/_archive/` do checkout principal;
   - `git worktree remove --force` do app-back e dos irmãos do ticket
     (`.claude/worktrees/<ticket>[-<repo>]` e `../<repo>/.claude/worktrees/<ticket>`),
     no repo dono de cada um. Worktree já inexistente = ignorado; worktree com mudança
     rastreada não commitada = mantido (nunca `--force` por cima de sobra sem PR);
   - **a branch local fica** — só o worktree sai;
   - grava `worktrees_removed_on_pr_open_at` + evento `worktrees_removed` (ou
     `worktree_cleanup_failed` + `worktrees_cleanup_errors`) — erro só é logado, nunca
     falha o commit; o que sobrar sai no cleanup pós-merge.
   Adia pro próximo tick enquanto o preview do dashboard do ticket está no ar ou outra
   task do ticket anda. **Push/PR pulado por falta de credencial (passo 7) = nenhuma URL
   em `pull_request` = worktrees ficam intactos** pro push/PR manual — então nunca grave
   em `pull_request` URL de PR que não abriu de fato. Recusa QA depois recria o worktree
   sozinha (retry do dashboard). `WORKTREE_CLEANUP_ON_PR_OPEN=0` no `.env` volta a
   limpar só depois do merge.
8. **Preencha "Apontamentos Desenvolvedor" no ticket Redmine** (habilitado
   desde 2026-09-02, ver `memory/decisions/2026-09-02-apontamentos-
   desenvolvedor.md`) pelo mesmo efeito governado, obrigação `redmine_notes`:
   ```
   node "$PRISMA_ROOT/scripts/lib/dom06-attempt.js" redmine-effect \
     --attempt "$DOM06_ATTEMPT_FILE" --obligation redmine_notes \
     --url "$REDMINE_URL/issues/<id>.json" --method PUT <<'EOF'
   {"issue":{"custom_fields":[{"id":<id do campo "Apontamentos Desenvolvedor">,"value":"<template abaixo>"}]}}
   EOF
   ```
   Sem `DOM06_ATTEMPT_FILE`, ou com exit 3, pare e avise — não caia no MCP
   (o MCP não consulta a autoridade do Attempt e pode duplicar a nota).
   `DUPLICATE` no stdout significa que o mesmo corpo já foi gravado. Se a
   task não veio de `/fetch-ticket`, ou se o Redmine estiver indisponível,
   pule este passo e avise — não bloqueia o resto do commit. O `value` é o
   campo customizado "Apontamentos Desenvolvedor", cada seção com conteúdo
   real (nunca deixe em branco — escreva "N/A" ou "Nenhum" explicitamente
   quando não houver):

   ```
   Resolução do Desenvolvimento:
   <o que foi resolvido, 1-3 frases, tom de fechamento de ticket>

   Projetos / Branch destino / Pull Requests:
   <repo: branch → branch destino (PR: <url de state.json.pull_request, se houver>); um por linha se tocou mais de um repo>

   Empresas afetadas:
   <cliente(s) citados no ticket/contexto; "Todos os clientes" se for genérico>

   Descrição do Desenvolvimento (técnico):
   <resumo técnico real: classes/métodos tocados, natureza da mudança — tirado de context.md e do diff, não invente>

   Como chegar no ponto do Desenvolvimento?
   <caminho de tela/fluxo pra reproduzir o cenário, se souber pela spec/ticket; senão "N/A — mudança de backend sem tela associada" ou equivalente>

   Novos campos/alteração de Campos BD (SQL):
   <listar migrações/DDL reais desta task; "Nenhum" se não houve>
   ```

   Se `memory/runs/<task-id>/context.md` não tiver informação suficiente pra
   alguma seção (ex: "como chegar na tela"), diga isso explicitamente no
   campo em vez de inventar.
8.1. **Propague horas (time entry) no ticket Redmine** a partir do
   `cost_tracking` / `*-cost.json` do run — mesma lib e marcador
   `[prisma-hours:<taskId>]` do backfill (`scripts/lib/redmine-hours-sync.js`).
   Rode **antes** do archive (passo 9), com o run ainda em `memory/runs/<task-id>/`:
   ```
   node "$PRISMA_ROOT/scripts/sync-redmine-hours-live.js" memory/runs/<task-id> \
     --apply --attempt "$DOM06_ATTEMPT_FILE"
   ```
   Sem `DOM06_ATTEMPT_FILE`, rode sem `--attempt` (POST direto via a lib). Sem
   ticket / sem `duration_ms` / `already_synced` / Redmine não configurado =
   skip (exit 0) — avise em uma linha e siga. Exit 3 (autoridade DOM06
   recusada) ou exit 1 (erro operacional): avise e **não** bloqueie o archive.
   Não invente horas: a lib só usa wall-clock do cost_tracking. Não rode o
   backfill one-shot daqui.
9. Marque `status = "committed"` e mova `memory/runs/<task-id>/` pra
   `memory/runs/_archive/<task-id>/` numa operação só, com CAS + `execution_id`:
   `node "$PRISMA_ROOT/scripts/state-writer.js" archive memory/runs/<task-id> --to=memory/runs/_archive/<task-id> --status=committed --expected-node=commit`
   (nunca `mv` nem edição direta do `state.json` — `docs/concurrency-map.md`). Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte.
   Depois, no arquivado, reduza o `context.md` a um resumo de 2-3 linhas (não o
   `context.md` inteiro) — o objetivo é não deixar o contexto de trabalho ativo
   crescer sem limite. Mantenha `state.json` completo (inclui `agent_log`, é o
   registro de quando cada nó rodou) e o `handoff.md` final tal como estava —
   não precisa resumi-lo, ele já é curto por construção. Depois de arquivar, rode
   de novo `node "$PRISMA_ROOT/scripts/lib/knowledge-graph.js" record <task-id>` (acha a task em
   `_archive/` sozinho) — o watcher também sincroniza a cada tick, isto só adianta.
   Por último, `node "$PRISMA_ROOT/scripts/invalidate.js" resolve memory/runs/_archive/<task-id>`: se
   uma transição de contrato chegou depois do `git commit`, ela fica registrada como
   `closed` (artefatos marcados STALE, run encerrado — nada é reaberto).

## Nunca
Nunca comite nada de `memory/` — ela é mantida só localmente. Nunca pule a atualização de `memory/` "porque não deu tempo" — é o próprio ponto
deste nó. Uma implementação sem esse passo é uma implementação que a próxima sessão
vai redescobrir do zero. Nunca dê push nem tente abrir PR sem
`BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`/`BITBUCKET_WORKSPACE` configurados — o
commit local (passos 1-6.5, incluindo repos irmãos tocados) sempre acontece
independente disso, só o passo 7 é condicional. Nunca imprima/logue o valor de
`BITBUCKET_API_TOKEN` em texto plano.
