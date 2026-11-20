---
name: prisma-docs-humano
description: >-
  SEMPRE entrega dois artefatos para Richard (PT-BR): (1) parte de negócio
  (*-humano.md — custo, qualidade, o que muda no dia a dia; O quê / Por quê /
  Quando / Próximos passos) e (2) parte técnica legível (mesmo file ou
  *-legivel.md — detalhe com glossário na 1ª ocorrência). Nunca só um dos
  dois. Decisões só se bloquearem o próximo passo. Use em status, review,
  handoff, ask Linear/store, resumo de issue ou comentário a Richard — mesmo
  sem pedido explícito de “versão humana”.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-docs-humano

## Regra de ouro — SEMPRE os dois

Toda vez que o destinatário for Richard (Project / Linear / store), a skill **obriga** os **dois** entregáveis. Entregar só negócio ou só técnico = incompleto.

| # | Parte | Arquivo típico | Conteúdo |
| --- | --- | --- | --- |
| **1** | **Negócio** | `*-humano.md` | Sentido / custo / qualidade / o que muda no dia a dia; formato O quê / Por quê / Quando / Próximos passos |
| **2** | **Técnica** | reescrita do técnico **ou** `*-legivel.md` ao lado | Detalhe atribuível com prosa clara + **glossário na 1ª ocorrência** antes de matriz/IDs |

Formas válidas:

- Dois files: `assunto-humano.md` + `assunto-legivel.md` (ou técnico original reescrito no lugar).
- Um file só: seção `# Para você` (negócio) **e** seção técnica legível abaixo — **ambas** presentes.

Anti-padrões de entrega:

- Só `*-humano.md` sem técnico / legível (link morto ou “veja o denso ilegível” não conta).
- Só review/matriz técnica sem parte de negócio.
- Negócio que é glossário disfarçado; técnico sem glossário na 1ª sigla.

Preferência do Project (2026-11-05): chat e docs em **sentido de negócio** (custo, qualidade, o que muda no dia a dia); evitar jargão/siglas na parte 1; se inevitável, português simples. Formato **O quê / Por quê / Quando / Próximos passos**. **Decisões** só se bloquearem o próximo passo — **não** são o centro do doc de negócio.

## Quando acionar (pushy)

Qualquer status, review, handoff, ask Linear/store, “o que falta”, “próximos passos”, comentário ou doc no store para Richard. Não esperar o humano pedir “versão humana”. Em **todo** acionamento: produzir **(1) + (2)**.

## 1) Parte de negócio (`*-humano.md`)

Espelhar `references/*-humano.md`. Antes de IDs, fases e siglas, responder em prosa clara:

| Pergunta | O que escrever |
| --- | --- |
| **Custo** | Tempo, cota de modelo caro, retrabalho ou espera que isto evita ou provoca se ignorado |
| **Qualidade** | Risco de decisão frágil, prova incompleta, “aprovo” genérico virar falsa autoridade |
| **Dia a dia** | O que muda (ou não) no uso: board, merge, status Linear, código do produto, próximos workers |

Template (detalhado; sem limite artificial de ~40 linhas se o detalhe for útil):

```markdown
# <assunto>

## O quê
<estado atual em português de negócio — o que aconteceu / o que está parado;
 o que isto **não** é (Approval, Done, merge, mudança de produto) quando couber>

## Por quê
<custo, qualidade ou impacto no dia a dia se agir / se ignorar;
 glossário só se a sigla for inevitável, em português simples>

## Quando
<em que momento isto vale: o que já passou, o que ainda não,
 ordem prática / dependências, o que pode andar em paralelo>

## Próximos passos
1. …
2. …

## Decisões (só se bloquearem o próximo passo)
- **…?**   # omitir a seção inteira se nada bloquear

---

Técnico: [`…`](./…) · Issue: […]
```

### Regras da parte de negócio

- **O quê / Por quê / Quando / Próximos passos** são **obrigatórios** e o centro desta parte.
- **Por quê** deve incluir pelo menos um de: custo, qualidade, o que muda no dia a dia.
- **Decisões** (sim/não): só quando resposta humana for pré-requisito do próximo passo; senão omitir a seção.
- Regra de sigla: **preferir zero**. Se inevitável, na 1ª ocorrência explicar em português simples o que precisa para decidir — não só expandir em inglês.
- Linkar (ou embutir) a **parte técnica** correspondente — a parte 2 não é opcional.
- PT-BR. Sem inventar **Approval**, **Done**, **APPLIED**, gate PASS ou merge.

Anti-padrões (negócio): sopa de siglas sem impacto; glossário técnico no lugar de custo/qualidade/dia a dia; centro = lista de decisões; inventar Approval/Done/APPLIED/merge.

## 2) Parte técnica (mesmo file ou `*-legivel.md`)

O técnico denso **não** some. Ou reescreve o técnico, ou gera `*-legivel.md` ao lado. Siglas sem contexto na hora = ilegível.

Antes de matriz/tabela/IDs:

1. **O que foi achado** — parágrafo(s) em português claro (sem sigla órfã).
2. **Por que importa** — consequência (risco, bloqueio, custo de ignorar, o que não pode fazer ainda).
3. **Glossário inline na 1ª ocorrência** — ex.: `RRC (candidato a mudança de arquitetura — só humano aplica)`, `PHI (regras humanas da reconciliação)`, `DS-09 (quem pode gravar a decisão — um writer só)`, `DB-16b (um dos itens que você precisa confirmar na PRI-181)`. Não pressupor DB-xx / PHI / DS-09 / RRC / CAS / AUTH-id.
4. Só então matriz, findings, hashes, paths.

Anti-padrões do técnico ilegível: abrir com tabela de metadados opaca; listar F-01…F-05 sem prosa; usar APPROVE_FOR_HUMAN_DECISION sem traduzir; entregar só a parte 2 sem a parte 1 de negócio.

Exemplo reescrito: `references/pri-225-cursor-review-legivel-excerpt.md`. Ouros de negócio: `references/pri-*-humano.md`, `references/linear-anti-recusa-humano.md` (sempre com técnico linkado ou excerpt ao lado).

## Regras

- **Sempre (1) + (2)** — incompleto se faltar qualquer um.
- Basear-se no doc/issue/diff citados — **sem inventar** escopo, Approval, Done ou APPLIED.
- UNKNOWN / ausência de prova permanece UNKNOWN.
- Skill irmã de evidência/PR/handoff: não substitui `prisma-pr-describe`, `prisma-handoff`, `prisma-linear-comment-evidence`.

## Fora do escopo

- Fechar issue Linear, merge, aplicar RRC, promover Active, escrever `state.json`/`log.json`.
- Apagar ou “resumir embora” o técnico denso sem deixar trilha legível (parte 2).
- Entregar só resumo de negócio “para não cansar” e omitir o técnico legível.
