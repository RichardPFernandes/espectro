---
description: Nó "Fetch Ticket" — entry point alternativo do grafo. Busca um ticket no Redmine via MCP, cria a branch do ticket e grava a spec inicial na memory/.
argument-hint: [numero-do-ticket]
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.



Você está executando o nó **Fetch Ticket**, um entry point alternativo do grafo
(ver `.graph/graph.yaml`) usado só quando a tarefa nasce de um ticket Redmine.

1. Busque o ticket #$ARGUMENTS no Redmine via MCP (descrição, campos
   customizados, comentários relevantes, anexos). Se o MCP do Redmine estiver
   indisponível (erro de conexão), pare aqui e avise — não invente conteúdo do
   ticket. Chame `mcp__redmine__getIssue` com
   `queryParams.include: ["attachments", "journals"]` — sem `attachments`,
   `issue.attachments` vem vazio mesmo com anexo no ticket.

   **1b. Anexos.** Se `issue.attachments` tiver itens, baixe-os passando o array
   como JSON via stdin (ou `--attachments '<json>'`), a partir do mesmo diretório
   onde a spec do passo 5 vai ser gravada:

   ```
   node <raiz-do-checkout-principal>/scripts/lib/attachment-downloader.js $ARGUMENTS <<'JSON'
   <issue.attachments em JSON>
   JSON
   ```

   (heredoc com `'JSON'` entre aspas: nome de arquivo com aspa/`$` não quebra o
   shell.)

   Os arquivos vão pra `memory/spec/$ARGUMENTS-attachments/` (imagem: original;
   PDF: original + `.txt` via `pdftotext`; DOCX: original + `.md`; XLSX: original
   + `.csv` da primeira sheet; resto — zip, código, executável — salvo sem abrir).
   O script lê `REDMINE_URL`/`REDMINE_API_KEY` do `.env` sozinho — não passe a
   key na linha de comando nem imprima o header Authorization. O resultado sai em
   stdout e em `memory/spec/$ARGUMENTS-attachments/attachments.json`
   (`downloaded[]` com `type`, `path`, `converted_path`, `excerpt`, `warnings`;
   `skipped[]` com `reason` — `size_exceeded` acima de `MAX_ATTACHMENT_SIZE_MB`,
   padrão 10 MB; `download_failed`, `foreign_host`, `missing_api_key`).

   Falha em qualquer anexo (ou do script inteiro) **não aborta o fetch_ticket** —
   anexos são contexto complementar, não bloqueante: registre os `skipped` e os
   `warnings` no intake (passo 6) e siga. Sem anexos, pule este passo.

   Abra com Read as imagens e os `converted_path` baixados antes de escrever a
   spec — é esse conteúdo que o passo 5 resume em `## Anexos`.
2. Antes de rodar `git status`, confira se já existe
   `memory/runs/$ARGUMENTS-pretask-question.md` (na raiz do repo — não no
   worktree, que pode nem existir ainda) com a seção `## Resposta` preenchida
   (texto real depois do cabeçalho, não só o comentário entre parênteses). Se
   sim, é uma decisão do usuário já registrada de uma tentativa anterior — siga
   por ela diretamente (sem perguntar de novo), apague o arquivo depois de
   aplicar a decisão, e prossiga para o passo 3.

   Rode `git status`. Se houver mudanças não commitadas, não troque de branch
   por cima de trabalho em progresso. **Importante: você roda como `claude -p`
   — um processo single-turn que roda e sai (ver `scripts/readmine-
   watcher.js`). Nada que você só disser na resposta desta sessão sobrevive
   até o próximo tick do watcher; ele despacha uma sessão nova, sem memória
   desta conversa.** Então, em vez de só avisar no texto de
   resposta, grave (ou atualize) `memory/runs/$ARGUMENTS-pretask-question.md`
   com o estado do working tree e a pergunta objetiva pro usuário, neste
   formato:

   ```
   ## Pergunta (gerado em <timestamp ISO>)
   <branch atual, arquivos modificados/untracked, e a pergunta objetiva —
   inclua contexto suficiente pra decidir sem reabrir a sessão>

   ## Resposta (edite esta seção pra responder — o próximo tick usa isso)
   ```

   Pare aqui (não prossiga pro passo 3) enquanto a seção `## Resposta` estiver
   vazia — o watcher não redespacha este ticket até ela ser preenchida (ver
   `pretaskAnswerPending`/`notifyPretaskBlocked` no watcher), e avisa você via
   Redmine/notificação local uma vez.
3. Crie/entre na branch do ticket, seguindo a convenção já usada no repo (branch
   nomeada só com o número do ticket, ex: `43386`, `43153`, `43312`):
   - Se já existir uma branch local `$ARGUMENTS`, apenas faça checkout (ignore os
     passos de branch base abaixo — a branch já existe, não recrie).
   - Se existir só em `origin/$ARGUMENTS`, faça checkout rastreando o remoto.
   - Senão, decida a branch base pelo campo customizado **"Branch Liberação"** do
     ticket (já vem junto dos campos customizados buscados no passo 1):
     - `"Dev - Local"` → base `development`
     - `"Master - Stage"` → base `master`
     - Campo ausente ou valor não reconhecido → pare e pergunte ao usuário qual
       base usar; não assuma.
     Dê `git fetch origin <base>`, depois crie `$ARGUMENTS` a partir de
     `origin/<base>`.
   - Nunca dê push desta branch — isso fica pro fluxo normal de PR do usuário.
4. **Mova o ticket para "Em Desenvolvimento"** (id 2, `mcp__redmine__updateIssue`
   com `status_id: 2`) — sinaliza pro time que o trabalho começou de verdade
   (branch criada/entrada com sucesso no passo 3). Vale tanto pra trabalho novo
   (vindo de Aprovada) quanto retrabalho (vindo de Recusa QA). Se a transição
   falhar (ex: campo customizado obrigatório faltando — mesmo tipo de achado
   já documentado em `.claude/commands/commit.md` pra "Ag Merge"), releia o
   erro, preencha o que for pedido e tente de novo; não é motivo pra abortar o
   fetch_ticket.
5. **Spec nova começa do template canônico** (`templates/spec.md.template`, guia em
   `docs/spec-guide.md`). Se `memory/spec/$ARGUMENTS-spec.md` ainda **não existe**,
   crie-a copiando o template — nunca escreva a spec do zero nem em outro formato:

   ```
   node "$PRISMA_ROOT/scripts/lib/spec-template.js" init $ARGUMENTS \
     --title '<subject do ticket>' --out memory/spec/$ARGUMENTS-spec.md <<'DESC'
   <description do ticket, literal>
   DESC
   ```

   (heredoc com `'DESC'` entre aspas: `$`/crase da descrição não são expandidos; no
   `--title`, escape aspas simples do assunto como `'\''`.) O script troca **só** os
   campos vindos do Redmine — número, título e descrição (que vai para `## Contexto`,
   com cabeçalhos `#`/`##` da descrição rebaixados para `###`) — e mantém o
   frontmatter `spec_template_version` e todos os comentários HTML de instrução.

   Depois disso, edite a spec **apenas** para:
   - acrescentar ao `## Contexto` o que for relevante nos comentários (journals) do
     ticket — fato do ticket, sem interpretar;
   - listar em `## Referências` os anexos baixados no passo 1b (abaixo) e tickets
     relacionados citados no Redmine.

   **Não preencha** `## Objetivo`, `## Escopo` nem `## Critérios de Aceite`, e **não
   apague** os comentários HTML: eles são as instruções para o desenvolvedor
   completar a spec. Mesmo que o ticket traga critérios explícitos, eles ficam no
   `## Contexto` (vieram com a descrição) — quem os transforma em `AC-NN` é uma
   pessoa. Pelo mesmo motivo este nó **não cria AC nem registra provenance de AC**
   (`docs/ac-provenance.md`): a provenance começa onde o AC é materializado (rascunho
   do spec-generator, auto-repair aprovado, SPEC_CHANGE aprovada, baseline do `/plan`). O portão de spec do watcher vai reprovar a spec (`SECTION_NOT_FILLED`,
   `TEMPLATE_COMMENTS_PRESENT`) e pausar o ciclo pedindo o preenchimento no
   Redmine — é o comportamento esperado, não um erro deste nó.

   **Spec já existente — não sobrescreva** (o `init` também se recusa: sai 1 sem
   mexer). Se `memory/spec/$ARGUMENTS-spec.md` já existir com
   `generated_from_ticket: true` no frontmatter, ela foi gerada pelo watcher a partir
   dos campos do ticket (`scripts/lib/spec-generator.js`) e **revisada por um humano**
   (que trocou `draft: true` por `draft: false` — só assim o ciclo chega aqui). Não
   regrave o arquivo: mantenha o frontmatter e todo o conteúdo revisado, e só
   complemente seções vazias com o que o ticket/comentários trazem (e acrescente os
   anexos). Se encontrar `draft: true`, pare e avise — o watcher não deveria ter
   despachado. Qualquer outra spec pré-existente (Recusa QA de ciclo anterior) é
   mantida como está, no formato em que foi escrita: spec legada (sem
   `spec_template_version`) **não é migrada** — o validador só emite aviso.

   Anexos, um item por arquivo em `downloaded[]` (em `## Referências` na spec do
   template; em `## Anexos` numa spec legada):

   ```
   - `{filename}` — {tipo}: {descrição em 1 linha do conteúdo}
     Arquivo: memory/spec/$ARGUMENTS-attachments/{saved_as}
   ```
   - imagem: acrescente `[ver conteúdo visual via Read]` e descreva o que o print
     mostra (tela, erro, dado) depois de abri-lo;
   - PDF/DOCX convertido: resumo de 2 linhas do texto extraído (`converted_path`)
     e o caminho do `.txt`/`.md`;
   - XLSX: as primeiras 3 linhas do CSV (campo `excerpt`) num bloco de código, e
     o caminho do `.csv`;
   - raw: só presença (nome e tipo) — não abra arquivo executável/compactado.
   Anexo em `skipped[]` não entra aqui (vai pro intake).

   **IDs são estáveis** (vale para spec pré-existente que já tem critérios). Mantenha
   todo ID já dado e o texto dele; critério que deixou de valer não é apagado — fica
   como `- AC-03: (removido em <data>: <motivo>) <texto original>`. Spec
   pré-existente **sem** IDs (anterior a esta regra): numere na ordem, sem mudar o
   texto, com `node <raiz-do-checkout-principal>/scripts/lib/ac-ids.js number memory/spec/$ARGUMENTS-spec.md --write`
   (continua depois do maior ID existente; sai 1 sem mexer se houver ID malformado
   ou duplicado — aí corrija o formato à mão, sem trocar o texto).

6. Registre uma entrada em `memory/decisions/$ARGUMENTS-intake.md` com: fonte
   (Redmine #$ARGUMENTS), timestamp, valor do campo "Branch Liberação" e a branch
   base usada, e um resumo de 2 linhas do que foi capturado — seguindo o mesmo
   padrão das outras decisions já salvas no grafo. Se o passo 1b rodou, inclua
   quantos anexos foram baixados e, para cada `skipped[]`/`warnings` (ex:
   `size_exceeded` com o tamanho real, `pdftotext` indisponível), uma linha com
   arquivo e motivo.
7. Gere o task-id no formato `$ARGUMENTS-<slug-curto>` (slug curto a partir do
   título do ticket, ex: `$ARGUMENTS-ajuste-status-transporte`).
8. Monte o `state.json` num arquivo temporário e grave com
   `node "$PRISMA_ROOT/scripts/state-writer.js" init memory/runs/<task-id> --input=<arquivo>` — nunca
   escreva `memory/runs/<task-id>/state.json` direto: o `init` é o início do ciclo
   (gera o `execution_id`, zera `processed_operations`, grava atômico; ver
   `docs/concurrency-map.md`). Formato em
   `.graph/schemas/state.schema.json`, com `node="plan"` — **não** `"fetch_ticket"`:
   a convenção deste campo é sempre "próximo nó a rodar", nunca "nó que acabou de
   rodar" (`history` é quem registra o que já rodou). Também
   `history=["fetch_ticket"]`, `status="in_progress"`, `started_at` no timestamp
   atual, `ac_ids` = só os IDs dos critérios da spec, na ordem (ex:
   `["AC-01","AC-02","AC-03"]`; `[]` se a seção ficou vazia — sempre o caso numa
   spec recém-criada do template — nunca o texto do
   critério, que vive só na spec), e `redmine_ticket={id, subject, tracker, base_branch}` — o assunto e o
   tracker (tipo) literais do ticket, e a branch base decidida no passo 3. Isso
   evita que o nó Commit precise reconsultar o Redmine só pra montar o título do
   PR (ver `.claude/commands/commit.md`).

   Com o state.json gravado, rode o validador apontando para ele:

   ```
   node <raiz-do-checkout-principal>/scripts/lib/spec-validator.js memory/spec/$ARGUMENTS-spec.md \
     --state memory/runs/<task-id>/state.json
   ```

   Ele grava `spec_template_version` no state.json (rastreabilidade de qual versão
   do template a spec segue; spec legada não grava nada e sai com o aviso
   `SPEC_TEMPLATE_VERSION_MISSING`). Spec recém-criada do template **vai sair
   inválida** (exit 1: seções a preencher, comentários do template presentes) — isso
   é esperado e não é motivo para preencher nada; registre os erros/avisos no intake
   (passo 6). Erro de formato `AC_ID_*`/`AC_EMPTY_TEXT` numa spec pré-existente:
   corrija o formato, nunca o conteúdo.

   **Por último — a spec está criada: registre a versão dela** (versionamento formal,
   `docs/spec-versioning.md`):

   ```
   node <raiz-do-checkout-principal>/scripts/lib/spec-version.js init memory/runs/<task-id>
   ```

   Grava o bloco `spec` no state.json: `version` = 1 (ou a última de
   `memory/spec/$ARGUMENTS-spec-changelog.json`, se a spec já tem histórico de ciclo
   anterior), `hash` = spec_hash contratual do HASH_SCOPE
   (`.claude/spec-hash-config.json`), `status: "draft"`. Nunca escreva esse bloco à mão
   nem antes de a spec existir. A spec do template ainda vai ser preenchida por uma
   pessoa: isso não gera versão nova — o `/plan` sela a versão sobre a spec preenchida.

## Nunca
Nunca avance para plan/implement nesta sessão — este nó só prepara a branch e os
arquivos de intake e o state.json. Diagnóstico e escolha de contexto são papel do
Plan. Nunca troque de branch com o working tree sujo, e nunca dê push.

## Ao terminar
Informe o task-id gerado e diga: rode `/plan <task-id>`.
