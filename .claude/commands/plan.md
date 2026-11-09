---
description: Nó "Plan" do grafo — diagnóstico, escopo, e seleção de contexto relevante em memory/spec/.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Argumento recebido: $ARGUMENTS (descrição da tarefa, ou um task-id se estiver
retomando um trabalho já iniciado).

Você está executando o nó **Plan**.

## SPEC = WHAT | PLAN = HOW

A spec da task (`memory/spec/<ticket>-spec.md`; task sem ticket:
`memory/spec/<task-id>-spec.md`) é a **autoridade** para Critérios de Aceite,
restrições funcionais, comportamento esperado e escopo funcional. Este nó é a
autoridade do **HOW**: diagnóstico técnico, arquivos afetados, estratégia, ordem de
execução, contexto selecionado, riscos técnicos e **como** cada AC será atendido.
O Plan **referencia** os ACs pelo ID — nunca cria, remove, reescreve ou reinterpreta
um critério. `context.md` e o intake são histórico/diagnóstico, não contrato
funcional: requisito funcional se busca na spec. Spec ambígua ou errada vira pergunta
registrada em `context.md` e em "Riscos técnicos" do `plan.md` — mudar o WHAT é
SPEC_CHANGE, que só humano aprova (`memory/decisions/2026-09-30-spec-what-plan-how.md`).

## Orçamento de contexto (vale para todos os passos)

Toda leitura fica no contexto e é reenviada em cada turno seguinte — um arquivo
inteiro lido no começo custa N vezes. Comprima a **entrada**, não o raciocínio: a
profundidade do diagnóstico (arquivos a tocar, dependências, riscos) não muda.

- **Parta do bloco `CONTEXTO PRÉ-MONTADO PELO ORQUESTRADOR`** do prompt, quando
  houver: descrição do ticket (3000 primeiros caracteres), arquivos citados no
  ticket, estrutura do projeto (só nomes), caminhos que casam com termos do ticket e
  os 6000 primeiros caracteres do `context.md`. Não releia o que já está ali.
- **Não chame `getIssue` de novo** para reler a descrição — ela está no bloco e/ou
  em `memory/spec/<ticket>-spec.md`. Só busque o ticket se precisar de algo que não
  está em nenhum dos dois (ex.: um comentário citado); nunca com journals duas vezes.
- **Arquivos citados diretamente no ticket: leia completos.** Os demais: localize
  com `grep -n`/`git ls-files | grep` e leia **só o trecho** relevante (`Read` com
  `offset`/`limit`, ~80–150 linhas em volta do ponto). Nunca abra um arquivo de
  código inteiro "pra conhecer" — se precisar de mais, leia outro trecho.
- **Sem subagentes** (Explore/general-purpose) neste nó — o despacho os bloqueia;
  um Explore custou 2,5× a sessão inteira de plan lendo Java completo.
- `memory/` e `memory/runs/<task-id>/` ficam no **cwd** (worktree do ticket). Não
  leia `scripts/readmine-watcher.js` nem liste o checkout principal pra descobrir
  isso. Templates: só `templates/` do cwd, uma vez.
- Se o `context.md` veio truncado e você precisa de uma seção do fim (ex.:
  `## Recusa QA`), leia só ela (`grep -n '^## ' context.md` + `sed -n`).

-1. **Registre a spec que governa esta execução** (Dependency Invalidation —
   `docs/dependency-invalidation.md`): `node "$PRISMA_ROOT/scripts/invalidate.js" begin memory/runs/<task-id> --node=plan`.
   Idempotente (despachado pelo watcher, o lease já registrou); sem ele, numa execução
   manual, um plano iniciado antes de uma SPEC_CHANGE aprovada não teria como ser
   reconhecido como da versão anterior. Task nova (o `/fetch-ticket` acabou de criar o
   run) também roda.
0. **Critério pendente de esclarecimento bloqueia este nó.** Antes de tudo, rode
   `grep -n 'PENDING_CLARIFICATION' memory/spec/<ticket>-spec.md`. Se algum critério
   de `## Critérios de Aceite` tiver o marcador `[PENDING_CLARIFICATION]`, **pare
   aqui**: não escreva `plan.md` nem mude `node`; registre em `context.md` quais ACs
   estão pendentes e informe que o /plan só roda depois que o solicitante esclarecer e
   o marcador sair da spec (`docs/spec-guide.md`). Um "aceito" no Redmine não libera
   esse bloqueio; o watcher também pausa a task (`spec-invalid`) pelo mesmo motivo.

1. Confira o estado real do projeto sem ler os arquivos inteiros:
   `grep -n -i '<termo>' memory/spec/index.yaml` com os termos da tarefa (~40 KB —
   nunca `cat`/`Read` completo; é a fonte do status de cada módulo). Histórico de
   tickets no mesmo módulo: `grep -l -i '<termo>' memory/decisions/*.md
   memory/runs/*/state.json`.
2. Confira `memory/patterns.md` (gerado por `scripts/memory-consolidator.js`, a
   partir do histórico real de `memory/runs/`) com
   `grep -n '^##\|^- ' memory/patterns.md` — **nunca `Read`/`cat` completo**. Se
   existir alguma entrada cujo módulo/palavra-chave bate com o escopo desta tarefa
   (ex.: mesmo módulo de negócio, mesmo tipo de endpoint/regra), cite-a
   explicitamente no `context.md` (passo 8) — é sinal de um padrão de falha de
   review ou de custo alto já observado nesse tipo de tarefa, útil pro Plan já
   antecipar um risco técnico ou uma verificação (nunca um AC novo — critério que
   falta na spec é pergunta pro solicitante). Arquivo ainda não existe
   (menos de 10 runs consolidados) ou nenhuma entrada relevante: siga sem citar
   nada — nunca bloqueie o Plan por isso.
3. **Leia a spec da task** — é dela, e não do `context.md`, que saem os requisitos
   funcionais: `## Critérios de Aceite` (IDs `AC-XX`; critério marcado
   "(removido em ...)" não conta), `## Restrições`, `## Solução` e o escopo. Se
   `memory/runs/$ARGUMENTS/state.json` já existir com `"fetch_ticket"` em
   `history` (task originada de `/fetch-ticket`), leia também
   `memory/decisions/<ticket>-intake.md` — diagnóstico de partida, não um novo
   escopo do zero (e não um segundo contrato). Acrescente `"plan"`
   ao `history` existente em vez de recriar o state.json.
4. Diagnostique a tarefa e inclua os repos relacionados explicitamente configurados
   em `memory/project.yaml`/`WATCHER_SIBLING_REPOS` quando a correção exigir. Não
   trate nenhum repo irmão como implícito. Use os worktrees do escopo aprovado;
   preserve mudanças alheias e registre restrições funcionais realmente pendentes.
5. Se a tarefa referenciar uma tela/programa específico, consulte o índice indicado
   em `memory/project.yaml > documentos_de_referencia` por busca dirigida, sem ler
   inteiro. Sem índice configurado ou arquivo ausente, registre a limitação e siga
   o diagnóstico; não invente caminhos de outro consumidor.
6. Usando `memory/spec/index.yaml` (via `grep`, ver passo 1), selecione só os
   arquivos de `memory/spec/` realmente relevantes a esta tarefa — nunca leia a spec
   inteira de uma vez.
7. Se $ARGUMENTS não for um task-id existente, gere um novo (slug curto + data, ex:
   `2026-08-23-migrar-auth-cookie`).
8. Grave `memory/runs/<task-id>/state.json` só pelo `scripts/state-writer.js` (nunca
   direto — `docs/concurrency-map.md`): run novo → monte o JSON e rode
   `node "$PRISMA_ROOT/scripts/state-writer.js" init memory/runs/<task-id> --input=<arquivo>`; run que
   já existia → os campos abaixo num patch (`set memory/runs/<task-id> --input=<patch.json>`)
   e o nó com `transition memory/runs/<task-id> --from=plan --to=implement`. Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte.
   Formato em `.graph/schemas/state.schema.json`, com `node="implement"` — a convenção é
   sempre "próximo nó a rodar", não "nó que acabou de rodar" (isso é `history`) —,
   `selected_context=[...]`, `scope="..."`. Se o state.json já existia (origem
   `fetch_ticket`), preserve o
   `started_at` original, o `ac_ids` (IDs dos Critérios de Aceite gravados pelo
   fetch_ticket — não os redefina) e só acrescente `"plan"` ao `history`; senão, crie do zero
   com `history=["plan"]`. Preencha também `current_agent="claude"` e acrescente uma
   entrada em `agent_log` no formato exato `{"agent": "claude", "nodes": ["plan"], "at": "<ISO-8601 UTC>", "note": "<resumo curto>"}` (`agent` é obrigatório no schema; entrada sem ele faz o watcher marcar a task `state_corrupted` e parar o ciclo) (`nodes: ["fetch_ticket", "plan"]` se
   fetch_ticket ainda não tinha sido registrado por outro despacho).
   **Depois** de gravar o state.json, registre o hash da spec que você leu (proteção
   contra drift — implement/review/test/verify pausam se a spec mudar depois disto
   sem SPEC_CHANGE aprovado):
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" baseline memory/runs/<task-id>`
   (grava `spec_path`, `spec_hash`, `spec_hash_at`, `spec_hash_by`, `spec_hash_scope`;
   exit 2 = task sem spec, siga sem baseline). Run versionado (state.json com bloco
   `spec`, gravado pelo `/fetch-ticket`): o baseline também **sela a spec_version**
   (`spec.status: "active"`, entrada `initial` em `memory/spec/<id>-spec-changelog.json`)
   e grava `spec_hash_version`; a saída imprime a linha
   `Spec: <spec> · spec_version=N · spec_hash=<12>` que vai no topo do `plan.md`
   (passo 11). Run legado (sem bloco `spec`): nada de versão — siga normal. Nunca
   grave `spec_change_approved`/`spec_change_hash` nem o bloco `spec` — são do humano
   e dos scripts.
   O baseline também registra provenance (`docs/ac-provenance.md`): todo AC da spec
   sem nenhum evento em `memory/spec/<id>-ac-provenance.json` ganha `UNKNOWN/ORIGIN`
   (linha `[ac-provenance] ...` na saída). Isso não é erro nem reprova nada, e você
   nunca declara autoria/origem no lugar de uma pessoa: `HUMAN_AUTHORED` (e qualquer
   outra origem sem evidência persistida) só entra por `ac-provenance.js declare`.
   **Replanejamento depois de SPEC_CHANGE aprovada** (`state.json.stale_artifacts`
   não vazio — `scripts/lib/spec-change.js`): a spec mudou (veja a última entrada de
   `## Histórico de Mudanças` e `spec-change-audit.json`) e `plan.md`/`handoff.md`
   são da versão antiga. Reescreva os dois do zero sobre a spec atual (passos 10 e
   11 — não reaproveite a cobertura dos ACs antiga, inclusive de AC removido ou
   substituído); o watcher tira cada um da lista quando ele é regerado.
   `acceptance-evidence.json` continua stale até o `/test` regravar a matriz — não o
   apague nem o edite. `context.md` é histórico: só acrescente.
   A validade de cada artefato (`state.json.artifact_validity`, Dependency Invalidation —
   `scripts/invalidate.js`, `docs/dependency-invalidation.md`) é gravada por script: o
   `baseline` acima carimba o plano novo como VALID contra a spec atual; review,
   evidence e verify da versão anterior continuam STALE até os nós deles rodarem de novo.
   Não edite `validity`, `artifact_validity` nem `pending_invalidation` à mão.
9. Escreva `memory/runs/<task-id>/context.md` com o diagnóstico por extenso —
   incluindo, se houver, o conteúdo relevante do intake do `fetch_ticket`.
10. Escreva `memory/runs/<task-id>/handoff.md` — o estado operacional que o
   **Implement** vai consumir (nunca releia `context.md` inteiro achando que
   precisa repetir tudo lá — o handoff é o resumo operacional). Seções:
   ticket, objetivo, etapa atual, status, agente atual, trabalho concluído,
   trabalho pendente, decisões relevantes, contexto
   arquitetural, constraints, riscos, próximo passo,
   timestamp. Referencie `selected_context` e arquivos de `decisions/` por
   caminho — não copie o conteúdo deles para dentro do handoff. Atualize
   `state.json.handoff_path` apontando para este arquivo.
   Critérios de aceitação entram **só por referência**, num bloco que todo nó
   seguinte preserva ao reescrever o handoff (o `/verify` confere contra a spec):

    ```markdown
    ## Referência da Spec
    - Spec: memory/spec/43646-spec.md
    - ACs: AC-01, AC-02, AC-03
    - Plan: memory/runs/43646-slug/plan.md
    ```

   `ACs:` = todos os IDs **ativos** da spec, nada a mais nem a menos. Nunca escreva
   `AC-XX: <texto>` no handoff: o texto do critério só existe na spec (cópia vira
   aviso; texto diferente reprova o Verify — seria uma segunda fonte de verdade).
11. Escreva **`memory/runs/<task-id>/plan.md`** — o artefato do HOW, que nenhum nó
    seguinte reescreve (o handoff muda a cada nó; o plano não). É a seção
    **`## Plano de execução`** dele que o portão de qualidade do watcher
    (`scripts/lib/plan-scorer.js`) avalia antes de despachar o Implement, e é com ele
    que o `/verify` liga cada AC da spec a um passo. Abra o arquivo com o mesmo bloco
    `## Referência da Spec` do handoff (sem a linha `Plan:`) — em run versionado, com a
    linha `Spec: … · spec_version=N · spec_hash=<12>` exatamente como o `baseline`
    imprimiu (o `/verify` confere: versão diferente da vigente = `SPEC_CHANGE_MID_RUN`)
    — e feche com
    `## Cobertura dos ACs` (uma linha por AC ativo: `- AC-01 → passos 1, 3 — <como>`;
    seta, não ":" — o "como" é HOW, o "o quê" é o texto da spec, que não se repete)
    e `## Riscos técnicos`, cuja primeira linha é
    `- Perfil: G<n> — <sinal>; capabilities afetadas: <lista em texto | nenhuma>`
    (perfil G0–G3 conforme `docs/handoff-contract.md`; ambíguo sobe). Formato:
    lista numerada de **3 a 10 passos**, cada passo
    com o arquivo afetado (caminho real), os Critérios de Aceite que atende e como
    verificar que ficou certo:

    ```markdown
    ## Plano de execução
    1. Filtrar transportadoras pelo resultado atual da tela.
       - Arquivo: `app-core/src/main/java/br/com/mosistemas/app/core/TorreControleViagensService.java`, `app-core/src/test/java/br/com/mosistemas/app/core/TorreControleViagensServiceTest.java`
       - Critérios: AC-01, AC-02
       - Verificação: teste unitário novo retorna só as transportadoras do resultado.
    ```

    **Linha `Arquivo:` = só caminhos.** O classificador de modelo (S2) lê essa linha
    para decidir a faixa do passo; linha ilegível vira sinal `UNKNOWN` e o passo sobe
    para Opus. Escreva cada caminho **concreto e completo** entre crases, separados
    por vírgula (sem `...`, curinga, diretório ou lista dentro de uma crase só) e use
    uma única linha `Arquivo:` por passo. Anotação, nome de método ou classe,
    annotation (`@Path`), branch e comentário como "(novo)" **não** ficam nessa
    linha: vão no texto do passo ou em outra linha (`- Detalhe: ...`). O plan-scorer
    avisa quando a linha não é legível.

    **A spec define O QUÊ; o Plan define COMO.** Use os IDs `AC-XX` da seção
    `## Critérios de Aceite` da spec exatamente como estão: todo AC precisa de ao
    menos um passo que o cite em `Critérios:`; nunca cite um AC que não existe na
    spec nem crie/renumere/reescreva critério no `plan.md` ou no handoff — AC
    omitido reprova o Verify (`PLAN_OMITS_AC`), ID inexistente também
    (`PLAN_UNKNOWN_AC`) (critério faltando é
    pergunta pro solicitante, registrada em riscos — não um AC novo do Plan). Passo
    que muda comportamento visível ao usuário (saída de endpoint, tela, regra de
    validação, filtro, ordenação ou persistência) precisa citar o AC que o
    justifica — se nenhum justifica, o passo está fora do escopo. Passo só de
    teste/revisão pode ficar sem `Critérios:`. Spec antiga sem IDs: cite `AC<n>`
    pela posição ou use os termos do critério, como antes. Nenhum passo pode
    contrariar uma restrição da seção Restrições da spec. Plano abaixo do score mínimo
    (`PLAN_SCORE_THRESHOLD`, padrão 60) volta pra este nó com o feedback no prompt
    (máx. 2 vezes) — se o prompt trouxer um bloco `RE-PLAN`, resolva cada ponto
    listado nele. Confira antes de terminar:
    `node "$PRISMA_ROOT/scripts/lib/plan-scorer.js" memory/runs/<task-id>/plan.md memory/spec/<id>-spec.md`.
12. **Contrato OpenAPI (só task de endpoint).** Se o diagnóstico concluiu que a task
    **cria ou modifica endpoint REST** (sinais: ticket/spec falam em "endpoint",
    "API", "Resource", `GET/POST/PUT/DELETE`, rota nova; ou o plano toca método com
    `@GET/@POST/@PUT/@DELETE/@PATCH` num `*Resource.java`), escreva por último
    `memory/runs/<task-id>/openapi-contract.yaml`. Se a task **não** envolve
    endpoint, **não crie o arquivo** (o Review e o dashboard usam a existência dele
    como sinal de que há contrato a conferir). É o contrato **desta task**, âncora
    para o Implement e o Review — **não** substitui nem edita qualquer OpenAPI do
    projeto, e nunca vai para `src/`.
    - OpenAPI **3.0.3**, YAML em bloco (sem âncora `&`/alias `*`/tag `!!`; flow curto
      tipo `{ type: string }` pode). Só os endpoints desta task — nada de copiar os
      demais métodos do Resource.
    - Por operação: `path` (o `@Path` da classe + o do método; prefixo da aplicação é
      opcional), método, `parameters` (path/query), `requestBody` com schema
      (`properties` com `type` + `required`) quando houver corpo, e `responses`
      **200 (ou 201/204, o que o método vai de fato devolver), 400, 422 e 500**, cada
      uma com `description` e `content.application/json.schema`.
    - **Exemplos realistas** (`example` no schema/propriedade ou no media type) com
      dados do domínio do ticket (oids, números de DT, CNPJs fictícios mas
      plausíveis) — nunca dado real de cliente, token ou senha.
    - Nomes de propriedade = nomes JSON que o DTO/record vai serializar (o nome do
      campo Java, ou o de `@SerializedName`/`@JsonProperty`). Declare
      `x-java-dto: <NomeDaClasse>` no `requestBody` (e em resposta 2xx com corpo
      estruturado, se houver DTO de resposta) e `x-java-method: <nomeDoMetodo>` na
      operação — é o que `scripts/lib/openapi-validator.js` usa para achar o
      DTO/método quando o corpo chega como `String json`.
    - Cite o arquivo em `handoff.md` (constraints: "respeitar
      `memory/runs/<task-id>/openapi-contract.yaml`") e inclua um passo no
      `## Plano de execução` do `plan.md` cuja verificação seja
      `node "$PRISMA_ROOT/scripts/lib/openapi-validator.js" memory/runs/<task-id>/openapi-contract.yaml <Resource.java> --md`
      sem `[FAIL]`.
    - Confira que o YAML é lido pelo validador antes de terminar:
      `node -e "require('./scripts/lib/openapi-validator').parseYaml(require('fs').readFileSync('memory/runs/<task-id>/openapi-contract.yaml','utf8'))"`
      (erro = YAML fora do subconjunto suportado; corrija).

## Nunca
Nunca escreva código neste nó. Nunca marque a tarefa como pronta pra Implement sem
ter listado escopo E fora de escopo explicitamente. Nunca copie a spec/decisions
inteiras para dentro do handoff — ele referencia, não duplica. Nunca edite a spec
neste nó, e nunca redefina, some, remova ou reescreva um Critério de Aceite (nem no
`plan.md`, nem no handoff, nem no `context.md`).

## Ao terminar
Informe o task-id gerado. Não rode `/implement` você mesmo — o watcher despacha a
próxima sessão a partir do `handoff.md` e `state.json` que você acabou de escrever.
Se estiver rodando manualmente fora do watcher, rode `/implement <task-id>`.
