# Orquestração barata (esteira Cursor / plataforma Prisma)

**Regra:** o **coordenador** (humano ou agente coordinator) orquestra. Workers / personas **não** encadeiam outras personas. Skills são hops obrigatórios **dentro** da ação — não um segundo roteador always-on.

**O que não é:** lifecycle `/build auto` ou `/ship` fan-out como Authority; não é Runtime watcher; não mistura C1 PRI-181.

Espelho: [`orchestration-patterns.yaml`](./orchestration-patterns.yaml).

---

## Padrões endossados

### 1. Invocação direta (default — mais barato)

```
coordenador → um worker / uma skill → artefato → coordenador
```

Use quando a fatia cabe numa frase e num sizing ≤ M.

### 2. Fan-out paralelo com merge

Vários workers **independentes** (sem estado mutável compartilhado); o coordenador faz o merge.

```
coordenador ─┬→ worker A (skill/faixa próprias)
             ├→ worker B
             └→ merge no coordenador
```

Checklist antes de paralelizar:

- [ ] Sem ordem obrigatória entre os braços
- [ ] Cada braço = uma ação do playbook + `skill`+`faixa` no brief ([`subtask-routing.md`](./subtask-routing.md))
- [ ] Merge cabe no contexto do coordenador
- [ ] Plano não sobrescreve unchecked de outra fatia (`prisma-plan-lite`)

### 3. Pipeline sequencial com checkpoints humanos

O coordenador (ou humano) corre passos na ordem do playbook; julgamento humano entre fases.

```
issue → plan-lite → (OK) → implement → tests → evidence → PR → handoff
```

Não automatizar o lifecycle inteiro num “orquestrador LLM” que resume entre nós — perde nuance e contorna Freeze/handoff.

### 4. Research isolation

Subagente **read-only** (Explore / equivalente) lê muito e devolve **digest**; o worker principal continua com contexto limpo.

```
worker → explore (só leitura) → digest → worker
```

**Proibido:** árvore profunda persona→persona; research com write/edit; tratar digest como Approval.

---

## Anti-padrões

| Anti-padrão | Por quê |
| --- | --- |
| Persona invoca persona | Custo + perda de accountability; coordenador some |
| Meta-skill Addy always-on | Segundo roteador vs playbook |
| Worker “aprova” gate / Freeze | Skill ≠ autoridade |
| Paralelizar migração/schema compartilhado | Corrida e conflito |
| Misturar faixa Runtime (`would_route` / S4) neste desenho | Filas separadas |

## Relação

| Doc | Papel |
| --- | --- |
| [`subtask-routing.md`](./subtask-routing.md) | Nascimento: ação→skill→faixa |
| [`context-packing.md`](./context-packing.md) | O que carregar por braço |
| [`skill-model-map.md`](./skill-model-map.md) | Faixa de modelo |
| Playbook | Qual skill na ação |
