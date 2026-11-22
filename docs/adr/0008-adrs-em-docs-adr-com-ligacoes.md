---
id: ADR-0008
status: aceita
data: 2026-11-18
capacidades: [ferramentas]
---

# ADR 0008: Os ADRs moram em `docs/adr/`, ligados às capacidades por ID no front-matter

**Fonte:** pedido do Richard na sessão da PRI-413 em 18/11/2026 (registrar a troca como ADR); PR #225 (F0.15, PRI-412), que criou `docs/adr/`; PR #235 (F0.16, PRI-413), que criou a conferência das ligações

## Contexto

A R-F2-01, opção A (26/10/2026, registrada na PRI-135, depois cancelada), punha o ADR aceito em `docs/sdd/decisions/`. Essa pasta nunca nasceu. A F0.15 abriu `docs/adr/` com sete decisões, sem dizer que trocava a R-F2-01. O status e as capacidades de cada ADR estavam só no texto.

## Decisão

Os ADRs moram em `docs/adr/NNNN-<nome>.md`. O front-matter traz `id`, `status` (MADR: proposta, aceita, rejeitada, obsoleta, substituída), `data`, `capacidades` e, quando houver, `substitui` e `substituida_por`, sempre por ID. A R-F2-01 A está substituída por esta decisão.

## Consequências

- A seção "Ligações" no fim de cada ADR e de cada capacidade é gerada por `node scripts/knowledge-links.js --write` (F0.16).
- O `processo-check` roda `knowledge-links --check` em todo PR, com o script da base: ID inexistente, lado divergente ou seção defasada reprovam.
- Nenhuma pasta `docs/sdd/decisions/` deve nascer.

<!-- ligacoes:inicio -->
## Ligações

- Capacidades: [ferramentas](../capacidades/ferramentas.md)
<!-- ligacoes:fim -->
