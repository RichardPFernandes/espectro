---
name: prisma-docs-humano
description: >-
  Redige docs e asks legíveis para Richard (PT-BR) em sentido de negócio
  (custo, qualidade, o que muda no dia a dia): *-humano.md no formato
  O quê / Por quê / Quando / Próximos passos; jargão/siglas evitados ou
  explicados em português simples; técnico legível com glossário na 1ª
  ocorrência. Decisões só se bloquearem o próximo passo. Use sempre que
  houver status, review, handoff, ask Linear/store, resumo de issue ou
  comentário dirigido a Richard — mesmo sem pedido explícito de “versão humana”.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-docs-humano

Dois entregáveis, sempre que o destinatário for Richard (Project / Linear / store):

1. **Versão humana** — linguagem de **negócio**; detalhe útil para agir sem abrir o técnico.
2. **Parecer técnico legível** — o técnico original **não** some; ou reescreve o técnico, ou gera `*-legivel.md` ao lado. Siglas sem contexto na hora = ilegível.

Preferência do Project (2026-11-05): chat e docs humanos em **sentido de negócio** (custo, qualidade, o que muda no dia a dia); evitar jargão/siglas; se inevitável, explicar em português simples. Formato **O quê / Por quê / Quando / Próximos passos**. **Decisões** só se bloquearem o próximo passo — **não** são o centro do doc.

## Quando acionar (pushy)

Qualquer status, review, handoff, ask Linear/store, “o que falta”, “próximos passos”, comentário ou doc no store para Richard. Não esperar o humano pedir “versão humana”.

## Linguagem de negócio (obrigatório na versão humana)

Antes de IDs, fases e siglas, o doc humano responde em prosa clara:

| Pergunta | O que escrever |
| --- | --- |
| **Custo** | Tempo, cota de modelo caro, retrabalho ou espera que isto evita ou provoca se ignorado |
| **Qualidade** | Risco de decisão frágil, prova incompleta, “aprovo” genérico virar falsa autoridade |
| **Dia a dia** | O que muda (ou não) no uso: board, merge, status Linear, código do produto, próximos workers |

Anti-padrões (versão humana):

- Abrir com sopa de siglas (P1, C1+, RRC, PHI, DS-09, F-01…) sem dizer o impacto em português.
- Traduzir jargão só com glossário técnico e **não** dizer custo / qualidade / dia a dia.
- Centro do doc = lista de decisões sim/não; passos e “por quê” viram apêndice.
- Inventar **Approval**, **Done**, **APPLIED**, gate PASS ou merge.

Regra de sigla: **preferir zero**. Se o ID for inevitável (issue, item de pacote), na 1ª ocorrência explicar em português simples o que a pessoa precisa saber para decidir — não só expandir a sigla em inglês.

## 1) Versão humana (`*-humano.md`)

Espelhar `references/*-humano.md`. Template fixo (detalhado; sem limite artificial de ~40 linhas se o detalhe for útil):

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

### Regras do formato humano

- **O quê / Por quê / Quando / Próximos passos** são **obrigatórios** e o centro do doc.
- **Por quê** deve incluir pelo menos um de: custo, qualidade, o que muda no dia a dia.
- **Decisões** (sim/não): incluir **somente** quando uma resposta humana for pré-requisito do próximo passo. Caso contrário, omitir a seção — não inventar lista de perguntas para “completar o template”.
- Preferir **detalhe útil** a resumo seco: o humano deve entender o contexto sem abrir o técnico.
- **Não apagar** o doc técnico. Preferir `nome-humano.md` ao lado. Se for o **único** file, prefixar seção `# Para você` no topo (mesmo template) e manter o técnico abaixo.
- PT-BR. Sem inventar **Approval**, **Done**, **APPLIED**, gate PASS ou merge.

## 2) Técnico legível (mesmo file ou `*-legivel.md`)

Antes de matriz/tabela/IDs:

1. **O que foi achado** — parágrafo(s) em português claro (sem sigla órfã).
2. **Por que importa** — consequência para o humano (risco, bloqueio, custo de ignorar, o que não pode fazer ainda).
3. **Glossário inline na 1ª ocorrência** — ex.: `RRC (candidato a mudança de arquitetura — só humano aplica)`, `PHI (regras humanas da reconciliação)`, `DS-09 (quem pode gravar a decisão — um writer só)`, `DB-16b (um dos itens que você precisa confirmar na PRI-181)`. Não pressupor DB-xx / PHI / DS-09 / RRC / CAS / AUTH-id.
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
