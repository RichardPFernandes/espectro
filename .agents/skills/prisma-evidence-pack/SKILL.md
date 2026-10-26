---
name: prisma-evidence-pack
description: Monta pacote curto de prova atribuível (HEAD, comandos, suítes, TAP/paths) sem declarar gate PASS nem escrever state.json. Use antes de handoff, PR ou comentário Linear quando faltar evidência.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

# prisma-evidence-pack

Empacota prova para alimentar handoff / PR / comentário Linear — **não** os substitui. Resultado interativo **não** é evidência oficial do ciclo despachado.

## Conteúdo mínimo

| Campo | Exemplo |
| --- | --- |
| Checkout / branch | path + branch |
| HEAD | SHA curto |
| Diff? | limpo / sujo (sim/não) |
| Comandos | receita exata (ex. `prisma-tests` / runbook) |
| Suítes | `scripts` / `dashboard` + exit codes |
| Artefatos | paths TAP, hashes se houver, links store/PR |
| Limite | interativo vs ciclo despachado |

## Regras

- Distinguir **prova interativa** vs evidência do watcher (`memory/runs/…`, gates).
- **Não** declarar gate PASS; **não** escrever `state.json` / avançar nó.
- Sem dados de consumidor, credenciais ou fixtures não admitidas (AGENTS.md §6).
- UNKNOWN / falha de infra ≠ PASS; listar cada `not ok` ou marcar UNKNOWN.
- Runbook (`docs/runbook.md`) e `prisma-tests` vencem se a receita divergir.

## Saída típica

Bloco markdown curto reutilizável em handoff (`validation.executed` + `evidence`), body de PR (`prisma-pr-describe`) ou comentário Linear (`prisma-linear-comment-evidence`).
