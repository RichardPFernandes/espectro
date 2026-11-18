# ADR 0007: Spec viva de uma página por capacidade, atualizada pelo delta no PR

**Status:** Aceita em 2026-11-17
**Fonte:** `roadmap/DECISOES.md` D5 (17/11/2026); Mesa `D-SDD-02`, pergunta P1 (16/11); SPEC arquivada `docs/historico/pri-396/SPEC-c1-mapa.md`

## Contexto

Entender o Espectro exigia ler o `README.md` inteiro e o código. A SPEC da fatia morre no merge, e não havia lugar para o comportamento atual de cada capacidade.

## Decisão

Cada capacidade tem uma página em `docs/capacidades/`, com requisitos e invariantes de ID estável. A mudança de comportamento chega como delta e atualiza a página no mesmo PR. A spec nasce quando uma fatia toca a capacidade; não se escrevem todas de uma vez.

## Consequências

- O mapa tem 16 capacidades; três têm spec viva (`spec`, `grafo`, `estado`) e o resto é `sem-spec`.
- O `/pri-*` abre a fatia pela spec viva e fecha com ela atualizada (F0.11 a F0.13). O `processo-check` avisa, sem reprovar.
- O writer de Self-SDD segue congelado, sem chamador.
