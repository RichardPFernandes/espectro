# PRI-207 — HOW aprovado; sem runtime

## O quê

Pacote A **já aprovado**: contexto mínimo no laço review→implement + escalonamento em sombra (ALT-3), sem subir tier sozinho. Decisões D-207-1…6 = A. Dependência Linear `blockedBy` PRI-191 **já limpa**. Isto **ainda sem** autorização de runtime: **não** autoriza código, watcher, schemas, thresholds numéricos, Attempt de escalonamento efetivo, nem ligação com qa-retry (PRI-184) — domínio distinto.

## Por quê

O HOW (How / desenho operacional acordado) está fechado; o que falta para build é **issue de implementação separada** + Promotion Gate (gate humano antes de promover implementação). Implementar envelope / sombra / Attempt nesta issue misturaria desenho já aprovado com runtime ainda não autorizado.

## Quando

Agora: tratar o HOW como fechado e **não** implementar nesta issue. Build (envelope / sombra / Attempt) só **quando** houver issue separada + Promotion Gate autorizado. N antes de “would_escalate” permanece UNKNOWN até evidência.

## Próximos passos

1. Tratar o HOW como fechado (D-207-1…6 = A).
2. **Não** implementar envelope / sombra / Attempt sem issue separada + Promotion Gate.
3. Quando quiser build: abrir issue de implementação separada e autorizar Promotion Gate nessa issue *(ainda não)*.

## Decisões (só se bloquearem o próximo passo)

- Abrir issue de implementação separada e autorizar Promotion Gate? *(só quando quiser build — omitível se o próximo passo for só manter o HOW fechado)*

---

Ask original: [`pri-207-human-ask.md`](./pri-207-human-ask.md) · Proposta: [`pri-207-proposal.md`](./pri-207-proposal.md) · Issue: [PRI-207](https://linear.app/prisma-app/issue/PRI-207)
