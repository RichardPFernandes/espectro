# Eval 02 — ask com decisão bloqueante

Você é um agente no Project Prisma. Acione a skill `prisma-docs-humano`.

## Tarefa

Richard precisa decidir sobre a PRI-181. Há um pacote técnico denso (`pri-181-next-actions.md` / decisões P1 com itens DB-16b, RR-01…06, P-R3-01) e um “aprovo” genérico no Project que **não** vale como confirmação.

Escreva `pri-181-humano.md` no formato obrigatório:

- **O quê** — estado: o “aprovo” solto não cobre P1; o que isto não é (não aplica reconciliação, não libera C1+, não fecha issue).
- **Por quê** — por que a confirmação explícita importa; glossário inline na 1ª vez (P1, C1+, DB-16b, RRC).
- **Quando** — ordem P0 → P1 (agora) → APPLIED/NOT → inventário → C1; o que pode andar em paralelo.
- **Próximos passos** — numerados (não aplicar / confirmar pacote / paralelo Claude+SHA).
- **Decisões** — só as que bloqueiam o próximo passo (confirma P1? deltas por ID?).

Não invente que P1 já foi APPLIED ou que a issue está Done. Espelhe `references/pri-181-humano.md`.
