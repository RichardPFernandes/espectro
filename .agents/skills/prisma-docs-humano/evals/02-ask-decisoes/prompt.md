# Eval 02 — ask com decisão bloqueante

Você é um agente no Project Prisma. Acione a skill `prisma-docs-humano`.

## Tarefa

Richard precisa decidir sobre a PRI-181. Há um pacote técnico denso (`pri-181-next-actions.md` / decisões com itens DB-16b, RR-01…06, P-R3-01) e um “aprovo” genérico no Project que **não** vale como confirmação.

Escreva `pri-181-humano.md` no formato obrigatório:

- **Sentido de negócio** — custo (cadeia parada / retrabalho), qualidade (“aprovo” genérico ≠ autoridade), o que muda (ou não) no dia a dia.
- **O quê** — estado: o “aprovo” solto não cobre; o que isto não é (não aplica reconciliação, não libera implementação, não fecha issue).
- **Por quê** — por que a confirmação explícita importa; se precisar de sigla (P1, C1+, RRC), explicar em português simples na 1ª vez.
- **Quando** — ordem prática; o que pode andar em paralelo.
- **Próximos passos** — numerados (não aplicar / confirmar pacote / paralelo Claude+SHA).
- **Decisões** — só as que bloqueiam o próximo passo (confirma o pacote? deltas por ID?).

Não invente que o pacote já foi APPLIED ou que a issue está Done. Espelhe `references/pri-181-humano.md`.
