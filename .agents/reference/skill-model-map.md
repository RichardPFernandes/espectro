# Mapa skill → faixa de modelo (desenvolvimento no Cursor)

**Para quê:** agentes e coordenadores escolhem o modelo certo por tipo de tarefa — para **não gastar o teto do Opus** em trabalho leve e **não baratear** decisão de arquitetura.

**O que não é:** não muda o produto em produção, não liga roteamento automático do watcher, não vira regra de CI.

**Fontes:** preferência do Project (2026-11-05) + análise no store (`analise-jev-skills.md`).  
**Calibração:** no planejamento, preferir qualidade (errar pra cima → Sonnet); tarefa bem simples → Sonnet; Opus só no pesado.

Espelho estruturado: [`skill-model-map.yaml`](./skill-model-map.yaml).

---

## Como ler

| Faixa | Quando usar | Exemplos de modelo (sessão Cursor) |
| --- | --- | --- |
| **leve** | Template, receita, redação a partir de diff/HEAD já obtidos | Composer / Grok / Sonnet low |
| **médio** | Delimitar escopo, plano, mapa Candidate típico, “cabe na baseline = sim” | **Sonnet** (preferido no planejamento) / Composer strong |
| **pesado** | Fora da baseline / Freeze, mapa SDD denso, implement estrutural (writers/schemas/multi-pacote) | **Opus** |

**Opus default = não.** Só linhas marcadas pesado ou escalação abaixo.

### Teste rápido (30 s)

1. Parecer sobre Freeze / Architecture Change / “aplicar” governança? → **pesado**.  
2. Muda WHAT (ACs/Decision) ou toca writers / `state.json` / schemas de proveniência de forma estrutural? → **pesado** (ou parar).  
3. Delimita escopo, riscos de contrato, ou mapa Candidate com juízo de RN? → **médio**.  
4. Só preenche template, roda receita, empacota prova, redige a partir de prova já coletada? → **leve**.

### Escalação

- “Não cabe” / RRC / Freeze no meio do trabalho → parar implement; `prisma-reconciliation-nav` em **pesado**.  
- Writer / `state.json` / schema de proveniência no escopo → implement (#6) **pesado**.  
- UNKNOWN que muda o WHAT → não inventar Approval; pesado **ou** pergunta humana.  
- Worker herdou Opus do pai numa ação leve (#7–#12) → **trocar** antes de rodar.

---

## Tabela (adotada)

| # | Skill / ocasião | Faixa default | Opus? | Modelo sugerido | Nota de uso |
| ---: | --- | --- | --- | --- | --- |
| 1 | `prisma-issue` | **médio** | Só Freeze/Architecture | Sonnet (errar pra cima) | Plano “pesado” em Opus queima quota antes de editar |
| 2 | `prisma-plan-lite` | **médio** | Não, salvo Freeze | Sonnet | Mesmo: fatia leve não precisa Opus |
| 3 | `prisma-reconciliation-nav` | **médio** se “cabe”; **pesado** se “não / RRC / Freeze” | **Sim** quando fora | Médio: Sonnet; fora: Opus | Barato errar “cabe” é caro depois |
| 4 | `prisma-sdd-discipline` | **médio** (auditoria); **leve** (só checklist) | Não no checklist | Sonnet / leve OK no lembrete | Checklist em Opus = desperdício |
| 5 | `prisma-ac-rn-map` | **médio**; **pesado** se mapa denso | Condicional | Sonnet; denso: Opus | Opus quando o mapa é miolo da Decision |
| 6 | *Editar código* (sem skill) | **médio** local; **pesado** estrutural | **Sim** no pesado | Sonnet/Composer; estrutural: Opus | Maior consumidor se Opus-default |
| 7 | `prisma-tests` | **leve** | **Não** | Composer / Grok / Sonnet low | Shell+grep; Opus não melhora exit code |
| 8 | `prisma-evidence-pack` | **leve** | **Não** | Composer / Grok | Template |
| 9 | `prisma-pr-describe` | **leve** | **Não** | Composer / Sonnet low | Diff já existe |
| 10 | `prisma-linear-comment-evidence` | **leve** | **Não** | Composer / Grok | Links/paths |
| 11 | `prisma-handoff` | **leve**; **médio** se BLOCKED denso | **Não** | Composer; Sonnet se BLOCKED | Validador é autoridade |
| 12 | `prisma-docs-humano` | **leve** | **Não** | Composer / Sonnet low | Alta frequência → Opus drena quota |

**Resumo Opus:** só `#3` (fora da baseline), `#5` (mapa denso), `#6` (implement estrutural), e escalação pontual de `#1`/`#2`.

---

## O que isto não autoriza

- Mudar como o produto escolhe modelo no ciclo automático.  
- Criar “prova de modelo certo” em CI ou declarar aprovação/merge por causa do mapa.  
- Tratar esta tabela como política do Runtime.
