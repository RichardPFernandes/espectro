---
name: prisma-docs-humano
description: >-
  Redige docs e asks legíveis para Richard (PT-BR): versão humana curta
  (*-humano.md) e parecer técnico/legível com glossário inline na 1ª ocorrência,
  abertura em português claro e explicação do porquê importa. Use sempre que
  houver status, review, handoff, ask Linear/store, resumo de issue ou
  comentário dirigido a Richard — mesmo sem pedido explícito de “versão humana”.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-docs-humano

Dois entregáveis, sempre que o destinatário for Richard (Project / Linear / store):

1. **Versão humana** — curta, decisões sim/não.
2. **Parecer técnico legível** — o técnico original **não** some; ou reescreve o técnico, ou gera `*-legivel.md` ao lado. Siglas sem contexto na hora = ilegível.

Preferência do Project (reforço): melhor **detalhado para humano** do que só resumir — explicar **por que importa**. Jargão (RRC, DB-xx, PHI, DS-09, gate…) nunca pressuposto.

## Quando acionar (pushy)

Qualquer status, review, handoff, ask Linear/store, “o que falta”, “próximos passos”, comentário ou doc no store para Richard. Não esperar o humano pedir “versão humana”.

## 1) Versão humana (`*-humano.md`)

Espelhar `references/*-humano.md`. Template fixo (~40 linhas max):

```markdown
# <assunto> — o que fazer agora

**Veredito:** <uma frase>

## Agora
1. …
2. …

## Decisões (sim / não)
- **…?**
- **…?**

## O que isto **não** é
- …

## Opcional (contexto)
- …  # curto; sem matriz densa

---

Técnico: [`…`](./…) · Issue: […]
```

- **Não apagar** o doc técnico. Preferir `nome-humano.md` ao lado. Se for o **único** file, prefixar seção `# Para você` no topo (mesmo template) e manter o técnico abaixo.
- PT-BR. Sem inventar **Approval**, **Done**, **APPLIED**, gate PASS ou merge.

## 2) Técnico legível (mesmo file ou `*-legivel.md`)

Antes de matriz/tabela/IDs:

1. **O que foi achado** — parágrafo(s) em português claro (sem sigla órfã).
2. **Por que importa** — consequência para o humano (risco, bloqueio, o que não pode fazer ainda).
3. **Glossário inline na 1ª ocorrência** — ex.: `RRC (Architecture Change Candidate)`, `PHI (Policy / Human Invariants da reconciliação)`, `DS-09 (decisão de writer único / Decision imutável)`, `DB-16b (item de decisão humana na PRI-181)`. Não pressupor DB-xx / PHI / DS-09 / RRC / CAS / AUTH-id.
4. Só então matriz, findings, hashes, paths.

Anti-padrões do técnico ilegível: abrir com tabela de metadados opaca; listar F-01…F-05 sem dizer o que cada um significa em prosa; usar APPROVE_FOR_HUMAN_DECISION sem traduzir.

Exemplo reescrito: `references/pri-225-cursor-review-legivel-excerpt.md` (trecho da review densa). Ouros humanos: `references/pri-*-humano.md`, `references/linear-anti-recusa-humano.md`.

## Regras

- Basear-se no doc/issue/diff citados — **sem inventar** escopo, Approval, Done ou APPLIED.
- UNKNOWN / ausência de prova permanece UNKNOWN.
- Skill irmã de evidência/PR/handoff: não substitui `prisma-pr-describe`, `prisma-handoff`, `prisma-linear-comment-evidence`.

## Fora do escopo

- Fechar issue Linear, merge, aplicar RRC, promover Active, escrever `state.json`/`log.json`.
- Apagar ou “resumir embora” o técnico denso sem deixar trilha legível.
