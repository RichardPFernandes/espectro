# ADR 0003: O bot mescla o PR Leve elegível; agente nunca mescla

**Status:** Aceita em 2026-11-18
**Fonte:** `roadmap/DECISOES.md` D12 (16/11/2026); Mesa `D-PRI-410-01` e `D-PRI-410-02` (18/11); SPEC `tasks/f0-8-merge-automatico-leve/SPEC.md`; PR #215 e #223 (F0.8, PRI-410); `CLAUDE.md`, regra 10

## Contexto

O merge era sempre do Richard, e PR Leve de documentação esperava dias por um clique. A medição de 16/11 mostrou o PR levando 13 minutos de aberto a mesclado e a issue esperando o aceite.

## Decisão

Com `MERGE_LEVE` ligado, o bot do GitHub Actions mescla o PR `processo:leve`, fora de draft, que só toca a lista `mergeLeve` de `.github/processo.json` na `main` e tem todos os checks verdes. O draft é a trava. Agente nunca mescla. O auto-merge nativo do GitHub não é usado.

## Consequências

- A lista é lida da `main`, não do PR: um PR não muda a própria permissão. `.github/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`, `docs/capacidades/` e `roadmap/DECISOES.md` ficam fora dela.
- O `/pri-pr` abre fora de draft só o Leve elegível; o resto abre em draft.
- Ligar `MERGE_LEVE` exige AUTORIZO próprio. Depois de cada merge do bot, o workflow dispara o Tests na `main` (#223).
