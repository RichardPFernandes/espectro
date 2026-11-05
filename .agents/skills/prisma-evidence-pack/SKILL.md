---
name: prisma-evidence-pack
description: Monta pacote curto de prova atribuível (HEAD, comandos, suítes, TAP/paths) sem declarar gate PASS nem escrever state.json. Use antes de handoff, PR ou comentário Linear quando faltar evidência.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve — sem Opus. Ver `.agents/reference/skill-model-map.md`.

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

## Common Rationalizations

| Racionalização | Realidade |
| --- | --- |
| “Os testes passaram, então gate PASS” | Pacote interativo ≠ evidência do ciclo despachado. |
| “Não preciso do HEAD, o branch basta” | Sem SHA a prova não é atribuível à versão. |
| “Posso omitir os `not ok`” | UNKNOWN/falha listados; omissão vira falsa autoridade. |
| “Incluo `.env` do consumidor na prova” | AGENTS.md §6 — credenciais/dados do consumidor não viajam. |

## Red Flags

- Pacote sem HEAD / comando / exit code.
- Linguagem de Approval/Done/APPLIED no bloco de prova.
- Prova que altera `state.json` ou tenta “fechar” verify.

## Verification

- [ ] HEAD + branch + limpo/sujo
- [ ] Comandos e exit codes (ou UNKNOWN)
- [ ] Paths TAP/artefatos; sem secrets de consumidor
- [ ] Nenhuma declaração de gate PASS

## Saída típica

Bloco markdown curto reutilizável em handoff (`validation.executed` + `evidence`), body de PR (`prisma-pr-describe`) ou comentário Linear (`prisma-linear-comment-evidence`).

Anatomia: [`.agents/reference/skill-anatomy.md`](../../reference/skill-anatomy.md).
