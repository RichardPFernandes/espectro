# Template de subtarefa (plan-lite)

Usar no plano interativo ou no body/notes do tracker (Project / Linear). **Não** duplicar num `tasks/todo.md` se o ambiente já tem lista autoritativa.

```markdown
## Subtarefa [N]: [título curto — um verbo, sem “e”]

**Descrição:** Um parágrafo do que entrega (fatia vertical).

**Acceptance criteria:**
- [ ] [condição específica e testável]
- [ ] [condição específica e testável]

**Verification:**
- [ ] Comando/receita: [ex. `node harness/run-tests.js …` / diff review]
- [ ] Evidência: [path TAP / HEAD / artefato]

**Dependencies:** [N anteriores | None]

**Files likely touched:**
- `path/a`
- `path/b`

**Estimated scope:** XS | S | M   # L+ → quebrar antes

**skill / faixa (se for spawnar worker):** `prisma-…` · leve|medio|pesado
```

Checkpoint (a cada 2–3 subtarefas):

```markdown
## Checkpoint: após [N–M]
- [ ] Receita/testes pertinentes OK (ou UNKNOWN explícito)
- [ ] Escopo ainda dentro da baseline
- [ ] Revisar com humano se risco de contrato / Freeze
```
