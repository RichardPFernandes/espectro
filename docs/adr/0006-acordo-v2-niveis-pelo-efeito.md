# ADR 0006: Três níveis de processo pelo efeito, com a evidência no PR

**Status:** Aceita em 2026-11-13
**Fonte:** Mesa `D-GER-02` (Richard, 13/11/2026); `AGENTS.md`, "Níveis de processo"; `roadmap/DECISOES.md` D12

## Contexto

A v2 do Acordo de desenvolvimento substituiu a v1. O processo precisava custar menos onde a mudança não toca o consumidor e mais onde toca.

## Decisão

O nível vale pelo efeito: Leve não muda código executado numa Run; Médio muda runtime ou dashboard atrás de flag desligada; Alto muda o que já roda no consumidor. O status mora no topo da issue, a evidência no PR, e o merge é do Richard.

## Consequências

- O nível é rótulo `Processo` na issue e `processo:<nível>` no PR, conferido pelo `processo-check`.
- Não há `evidence-*.md`, `handoff-*.yaml` nem adendo de SPEC; Alto exige SPEC, AUTORIZO próprio e readback.
- Subir de nível exige o Richard. A única exceção ao merge dele é o bot do Leve (ADR 0003).
