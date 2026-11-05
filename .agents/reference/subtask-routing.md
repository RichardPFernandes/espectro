# Criação de subtarefa → skill → faixa (esteira Cursor)

**Para quê:** na **nascença** de uma subtarefa / worker do Project, classificar ação → skill → faixa de modelo **antes** de spawnar — o mesmo vocabulário do [mapa skill→modelo](./skill-model-map.md).

**O que não é:** não muda o ciclo automático do produto, não grava `would_route` em Attempt, não liga S4, não é Authority Runtime.

**Preferências:** no planejamento, errar pra cima (qualidade → Sonnet); tarefa bem simples → Sonnet; Opus só no pesado.

Espelho estruturado: [`subtask-routing.yaml`](./subtask-routing.yaml).  
Playbook ação→skill: [../playbook/README.md](../playbook/README.md).

---

## Quando usar

Sempre que o coordenador (ou um agente) **criar** tarefa filha, despachar worker, ou recortar fatia com modelo próprio — **antes** do spawn.

Não substitui a sombra Runtime (`would_route` no Attempt): essa mede o watcher; isto disciplina a **esteira**.

---

## Checklist (obrigatório na nascença)

1. **Recortar uma ação** do playbook (uma subtarefa = uma ocasião dominante; “e …” no título = quase sempre duas).  
2. **Carregar a skill** em `.agents/skills/<nome>/SKILL.md` (ou ocasião *editar código*, sem skill).  
3. **Ler a faixa** em [`skill-model-map.md`](./skill-model-map.md) (leve / médio / pesado).  
4. **Aplicar viés:** dúvida no plano → médio/Sonnet (não Opus por hábito); bem simples → Sonnet; pesado → Opus só se Freeze / mapa denso / implement estrutural.  
5. **Quebrar herança:** se o pai está em Opus e a faixa é leve (tests, evidence, PR, comment, handoff limpo, docs-humano) → **trocar** o modelo do worker.  
6. **Anotar no brief** da subtarefa: `skill: …` · `faixa: leve|medio|pesado` · modelo sugerido. Espelho **humano** do would_route na esteira — preferência revisável, não Attempt.

Fan-out paralelo: cada filho com skill+faixa própria.

---

## Tabela rápida — ação → skill → faixa default

| Ação (playbook) | Skill | Faixa default | Opus? |
| --- | --- | --- | --- |
| Issue / continuar PRI | `prisma-issue` | médio | Só Freeze/Architecture |
| Planejar sem watcher | `prisma-plan-lite` | médio | Não (salvo Freeze) |
| Cabe na baseline? | `prisma-reconciliation-nav` | médio / **pesado** se fora | Sim se fora |
| Disciplina SDD | `prisma-sdd-discipline` | médio (auditoria) / leve (checklist) | Não no checklist |
| Mapa AC→RN | `prisma-ac-rn-map` | médio / pesado se denso | Condicional |
| Editar código | — | médio / **pesado** estrutural | Sim no pesado |
| Testes (receita) | `prisma-tests` | **leve** | **Não** |
| Pacote de prova | `prisma-evidence-pack` | **leve** | **Não** |
| Body de PR | `prisma-pr-describe` | **leve** | **Não** |
| Comentário Linear | `prisma-linear-comment-evidence` | **leve** | **Não** |
| Handoff | `prisma-handoff` | leve / médio se BLOCKED denso | **Não** |
| Docs humano+técnica | `prisma-docs-humano` | **leve** | **Não** |

Detalhe e teste de 30 s: [`skill-model-map.md`](./skill-model-map.md).

---

## Dependência externa (não reanalisar aqui)

Padrões de breakdown / contexto / orquestração do catálogo [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) são analisados **fora** desta fatia (store `docs/analise-addy-agent-skills-humano.md`, PRJ-104; adaptação PRJ-106). Este arquivo só exige o rito skill→faixa na nascença.

Formato `SKILL.md`: [agentskills.io](https://agentskills.io). Path das skills Prisma: `.agents/skills/` — **não** substituir por install em massa.

---

## Relação com sombra Runtime

| Esteira (este doc) | Runtime (`would_route`) |
| --- | --- |
| Anotação no brief do worker | Campo no Attempt, `applied: false` |
| Preferência Project | Policy versionada + classificador sombra |
| Medição = observação humana | Dashboard Operação › Medição de modelo |

Não copiar R1–R8 para o Project. Não inventar S4 a partir deste checklist.

---

## O que isto não autoriza

- Troca real de modelo no watcher (`mode=ON`, S4).  
- Decomposição Implement→Attempts (PRI-234).  
- Skill Registry / dual-write `.claude/skills/` para o ciclo.  
- Declarar Approval / Done / gate PASS.  
- Reabrir análise ou install do catálogo Addy neste path.
