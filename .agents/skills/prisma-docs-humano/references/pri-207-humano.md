# PRI-207 — o que fazer agora

**Veredito:** pacote A **já aprovado** (contexto mínimo no laço review→implement + escalonamento em sombra, sem subir tier sozinho) — **ainda sem** autorização de runtime.

## Agora

1. Tratar o HOW como fechado (decisões D-207-1…6 = A).
2. **Não** implementar envelope / sombra / Attempt sem issue separada + Promotion Gate.
3. Dependência Linear `blockedBy` PRI-191: **já limpa**.

## Decisões (sim / não) — histórico

| # | Pergunta | Resposta |
|---|----------|----------|
| 1 | Escalonamento em sombra (ALT-3), sem auto-bump? | **Sim (A)** |
| 2 | Aceitar envelope de contexto mínimo + reversão? | **Sim (A)** |
| 3 | Só `review → implement` nesta fatia? | **Sim (A)** |
| 4 | N antes de “would_escalate” fica UNKNOWN? | **Sim (A)** |
| 5 | Limpar bloqueio da PRI-191? | **Sim — feito** |
| 6 | Evidência: preferir pasta Mac + store? | **Sim (A)** |

## O que isto **não** autoriza

- Código, watcher, schemas, thresholds numéricos.
- Attempt de escalonamento efetivo.
- Ligação com qa-retry (PRI-184) — domínio distinto.

## Próximo passo humano (quando quiser build)

- Abrir issue de implementação separada?
- Autorizar Promotion Gate nessa issue? *(ainda não)*

---

Ask original: [`pri-207-human-ask.md`](./pri-207-human-ask.md) · Proposta: [`pri-207-proposal.md`](./pri-207-proposal.md) · Issue: [PRI-207](https://linear.app/prisma-app/issue/PRI-207)
