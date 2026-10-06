> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
+> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
+> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
+> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
+> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.
+
# .graph/ — motor de execução

Este diretório não muda entre projetos. Define o ciclo Plan → Implement → Review →
Test → Verify → Commit como um grafo real (nós, arestas, condições de retry) em vez
de uma sequência de prompts que só existe na cabeça de quem está conduzindo a sessão.

## Por que um arquivo, não só instrução em prosa

Um `state.json` por task (ver `schemas/state.schema.json`) permite três coisas que
prosa em `CLAUDE.md` não permite:

1. **Um hook pode bloquear uma transição inválida** — ex.: `git commit` antes do nó
   chegar em `verify` (ver `.claude/settings.json` + `.claude/hooks/`).
2. **Loops têm limite explícito.** `max_retries` em cada nó evita o caso real que
   aconteceu no projeto que originou este template: 3+ reprovações seguidas do mesmo
   par Implement↔Review normalmente é sinal de escopo errado no Plan, não de bug
   pequeno — o grafo escala pro humano em vez de insistir silenciosamente.
3. **Retomar uma task depois de fechar a sessão é trivial** — o próximo `/plan` ou
   `/implement <task-id>` lê o `state.json` e sabe exatamente onde parou, sem
   depender de você lembrar o contexto da conversa anterior.

## Como isto otimiza memória de contexto

O ponto crítico não é só "ter um grafo" — é o que cada nó carrega no contexto:

- **Plan** é o único nó que consulta `memory/spec/index.yaml` (barato: é um índice,
  não o conteúdo). A partir dele decide `selected_context`: os 2-3 arquivos de
  `memory/spec/` realmente relevantes pra esta tarefa.
- **Implement, Review, Test, Verify** leem só `selected_context` + o `context.md` da
  própria task (que vai acumulando diagnóstico → mudança → veredito → resultado) —
  nunca a memória inteira do projeto.
- **Commit** é o único nó que lê `context.md` inteiro e o dobra de volta pra memória
  permanente (spec, status, decisions) — e só então arquiva o run.

Isso é o equivalente, com pastas e YAML em vez de embeddings, a um RAG: o índice
decide o que entra no contexto, o `context.md` é o "state" que atravessa o grafo (o
mesmo conceito de `state` de frameworks como LangGraph), e só o nó terminal persiste
de volta pra memória de longo prazo.

## Continuidade entre sessões (`handoff.md`)

Desde 2026-09-02 o watcher (`scripts/readmine-watcher.js`) despacha **um
segmento por vez** — uma única invocação de `claude -p` cobrindo um ou poucos
nós consecutivos — nunca o grafo inteiro numa tacada só: ele lê
`state.json.node`, dispara Claude nesse nó, e sai — quem redespacha o próximo
passo é o próximo tick do watcher, não o processo que acabou de rodar. Isto
existia originalmente para permitir um segundo agente de orquestração (Codex
CLI) além do Claude; o Codex foi removido do fluxo em 2026-09-18 (ver
`memory/decisions/2026-09-18-remocao-codex-workflow.md`), mas o checkpoint por
segmento continua valendo porque resolve um problema independente disso: a
sessão de um nó pode morrer, esgotar contexto ou ficar indisponível no meio do
trabalho.

Isso significa que nenhuma sessão pode confiar na própria memória de conversa
para saber o que fazer a seguir: cada despacho começa lendo `state.json` +
`context.md` + **`handoff.md`** (um arquivo por task, em
`memory/runs/<task-id>/handoff.md`).

- `context.md` continua sendo o "state" completo que atravessa o grafo
  (diagnóstico → mudança → veredito → resultado, tudo por extenso).
- `handoff.md` é menor: só o estado OPERACIONAL atual (objetivo, etapa,
  trabalho concluído/pendente, decisões relevantes, constraints, critérios de
  aceite, riscos, próximo passo). Ele referencia `context.md` e
  `decisions/*.md` por caminho — nunca copia o conteúdo deles. É reescrito a
  cada transição de nó (Plan→Implement, Implement→Review, Review→Test, etc.),
  sempre sobrescrevendo a seção que mudou, não acumulando histórico (o
  histórico já vive em `context.md` e em `state.json.agent_log`).
- `state.json.agent_log` registra cada despacho (nós cobertos, timestamp) — é
  o que permite reconstruir, por task, o que rodou e quando, sem depender de
  nenhuma sessão específica.

Isto é o mecanismo de failover: se a sessão morre/esgota contexto/fica
indisponível no meio de um nó, o próximo tick do watcher vê `state.json`
ainda apontando pro node não concluído e redespacha — sempre a partir do
`handoff.md` mais recente, nunca da conversa anterior.
