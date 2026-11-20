# Context packing (esteira Cursor / plataforma Prisma)

**Para quê:** carregar o **mínimo suficiente** na sessão/worker — quality sobe, custo de contexto cai.

**O que não é:** não é skill always-on do Addy; não é Authority Runtime; não grava estado do consumidor; não substitui `AGENTS.md` nem handoff.

**Onde vive:** bootstrap da plataforma (`.agents/reference/`). Viaja com o Prisma inserido em projetos consumidores; **não** inventa rules/config do app consumidor.

Espelho curto: [`context-packing.yaml`](./context-packing.yaml).

---

## Hierarquia (persistente → transitório)

1. **Rules da plataforma** — `AGENTS.md`, este playbook/mapa/skills (sempre).
2. **Spec / issue / baselines** — só a fatia pertinente (PRI, provenance citados), não o monorepo inteiro de docs.
3. **Arquivos da tarefa** — ler o que vai mudar + um exemplo de padrão vizinho + tipos/contratos tocados.
4. **Erros / TAP** — falha específica, não log de 500 linhas.
5. **Histórico da conversa** — compactar ou **nova sessão** em fronteira de subtarefa concluída (handoff restartável).

## Packing seletivo

| Incluir | Evitar |
| --- | --- |
| Skill da ação + faixa do mapa | Meta-skill genérica always-on / pacote Addy inteiro |
| Paths e ACs da fatia | Dump de issues não relacionadas |
| Handoff / brief com `skill`+`faixa` | Colar documentos inteiros (referenciar paths) |
| Exit code + trecho `not ok` | Pasta `node_modules`, secrets, fixtures de consumidor |

## Confusion stop

Se o contexto conflita (dois planos, baseline ambígua, WHAT vs HOW): **parar e perguntar** — não “resolver no feeling” nem misturar fila Runtime (S4 / would_route) com este packing.

## Sessão restartável

Antes de trocar de sessão/worker, persistir no artefato durável (handoff / brief / tracker):

1. escopo aceito e decisões aprovadas vs hipóteses;
2. subtarefa atual + próxima;
3. arquivos tocados / estado do working tree;
4. comandos de verificação e resultado;
5. UNKNOWN / aprovações humanas ainda abertas.

Na sessão nova: ler rules → spec/issue → plano/handoff → `git status` antes de agir. Não inferir Approval de conversa anterior sem artefato.

## Relação com outros docs

| Doc | Papel |
| --- | --- |
| [`subtask-routing.md`](./subtask-routing.md) | O que anotar na **nascença** do worker |
| [`orchestration-patterns.md`](./orchestration-patterns.md) | Quem orquestra; research isolation |
| `prisma-handoff` | Contrato YAML na fronteira |
| `prisma-plan-lite` | O que planejar antes de editar |
