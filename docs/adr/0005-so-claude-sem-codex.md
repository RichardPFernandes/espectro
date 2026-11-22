---
id: ADR-0005
status: aceita
data: 2026-11-03
capacidades: []
---

# ADR 0005: Só Claude; a revisão independente é outro agente Claude em contexto limpo

**Fonte:** Mesa `D-GER-01` (Richard, 03/11/2026); `docs/handoff-contract.md`, regra de revisão independente G3 (troca registrada em 06/11/2026)

## Contexto

O desenvolvimento do Espectro dividia o trabalho entre Claude e Codex, com a regra de revisor em outro runtime. O Richard deixou de usar o Codex. (Outra decisão, de 18/09/2026, já tinha tirado o Codex do fluxo do consumidor: `docs/runbook.md`.)

## Decisão

Tudo roda em Claude. O Codex sai do fluxo. "Revisor em runtime diferente" vira "revisor independente": outro agente Claude, sem o contexto da implementação.

## Consequências

- A revisão é por subagente em contexto limpo (`agent-skills:code-reviewer`), com o modelo escolhido pelo nível: sonnet no Leve, opus no Médio e no Alto.
- Nada é roteado ao Codex; a capacidade que conta é a cota Claude.
- Reversível quando houver um segundo runtime (`docs/handoff-contract.md`); isso exigiria um ADR novo.
