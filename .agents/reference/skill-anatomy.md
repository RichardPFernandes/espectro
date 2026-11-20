# Anatomia de skill Prisma (plataforma)

**Para quê:** ao **criar ou editar** skills em `.agents/skills/<nome>/SKILL.md`, usar a mesma espinha (Overview / When / Process / **Common Rationalizations** / **Red Flags** / Verification) — padrão de escrita, não pacote Addy instalado.

**Path canônico:** `.agents/skills/` (não migrar para `.cursor/skills/` sem decisão explícita).

**O que não é:** Authority Runtime; campo `model` top-level no frontmatter portátil (faixa fica no [`skill-model-map.md`](./skill-model-map.md) / preferência do host); DoD genérico como gate; instalação `npx skills add` em massa.

---

## Frontmatter

```yaml
---
name: prisma-<nome>   # = diretório
description: >-
  O que faz (3ª pessoa). Use when <gatilhos concretos>.
  # pushy o bastante para nascença de subtarefa; ≤1024 chars
---
```

Chaves top-level: só as do [Agent Skills](https://agentskills.io) (`name`, `description`, …). **Não** colocar `model` no top-level — roteamento de modelo = mapa/preferência da esteira, não Authority no SKILL.

Banner padrão (após frontmatter):

```markdown
> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.
```

Linha de faixa (obrigatória na esteira):

```markdown
**Faixa de modelo:** leve|médio|pesado — …. Ver `.agents/reference/skill-model-map.md`.
```

## Seções recomendadas

1. **Overview** — o que / por que seguir  
2. **When to Use** / exclusões (When NOT)  
3. **Process / Checklist** — passos acionáveis (comando concreto > conselho vago)  
4. **Common Rationalizations** — desculpa do agente → realidade  
5. **Red Flags** — sinais observáveis de violação  
6. **Verification** — exit criteria com prova  

Supporting files (`references/`, `evals/`) só se necessários — sem pastas vazias.

## Exemplos no repo

| Skill | Anatomia |
| --- | --- |
| `prisma-plan-lite` | sizing + AC + rationalizations + red flags + verification |
| `prisma-handoff` | rationalizations + red flags (contrato já é autoridade) |
| `prisma-evidence-pack` | rationalizations + red flags |

## Ao despachar

Description pushy + playbook + [`subtask-routing.md`](./subtask-routing.md) bastam para achar a skill na nascença. **Não** empilhar meta-skill `using-agent-skills` do Addy.
