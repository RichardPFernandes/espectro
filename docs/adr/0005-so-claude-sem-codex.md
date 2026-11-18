# ADR 0005: Só Claude; a revisão independente é outro agente Claude em contexto limpo

**Status:** Aceita em 2026-11-03
**Fonte:** Mesa `D-GER-01` (Richard, 03/11/2026)

## Contexto

O desenvolvimento dividia o trabalho entre Claude e Codex, com a regra de revisor em runtime diferente. O Codex já travava revisões por limite de uso, e o Richard deixou de usá-lo.

## Decisão

Tudo roda em Claude. O Codex sai do fluxo. "Revisor em runtime diferente" vira "revisor independente": outro agente Claude, sem o contexto da implementação.

## Consequências

- A revisão é por subagente em contexto limpo (`agent-skills:code-reviewer`), com o modelo escolhido pelo nível: sonnet no Leve, opus no Médio e no Alto.
- Nada é roteado ao Codex; a capacidade que conta é a cota Claude.
