# ADR 0002: Monólito modular por capacidade, sem Arquitetura Limpa nem DDD tático

**Status:** Aceita em 2026-11-16
**Fonte:** Mesa `D-SDD-02`, pergunta P3 (a resposta registrada aprova as fatias C1 a C4; a P3 ficou como recomendação, e o Richard a lista como tomada na PRI-412); `tasks/spec-viva-do-espectro/PROPOSTA.md`

## Contexto

`scripts/lib` tem mais de 110 arquivos sem subpasta, e o dono de cada arquivo não estava escrito. A proposta comparou organizar por capacidade com adotar Arquitetura Limpa ou DDD tático.

## Decisão

A estrutura de código segue as capacidades de `docs/capacidades/`: um monólito modular, com cada capacidade dona dos seus arquivos. Sem camadas de Arquitetura Limpa e sem DDD tático.

## Consequências

- O dono de cada arquivo de código está no cabeçalho da capacidade, e um teste (`capability-map.test.js`) reprova arquivo de código sem dono.
- Nenhum movimento de arquivo está agendado. Só módulo novo (`grafo` na F2.7, `config-central`) já nasce em pasta própria.
- Quando houver movimento, é um módulo por PR, com entrada só pelo `index.js`.
