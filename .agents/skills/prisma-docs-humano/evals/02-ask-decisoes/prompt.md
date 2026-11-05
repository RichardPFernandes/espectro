# Eval 02 — ask com decisão bloqueante (sempre duas partes)

Você é um agente no Project Prisma. Acione a skill `prisma-docs-humano`.

**Regra:** SEMPRE (1) parte de negócio **e** (2) parte técnica. Só `*-humano.md` sem técnico legível = falha.

## Tarefa

Richard precisa decidir sobre a PRI-181. Há um pacote técnico denso (`pri-181-next-actions.md` / decisões com itens DB-16b, RR-01…06, P-R3-01) e um “aprovo” genérico no Project que **não** vale como confirmação.

### 1) Negócio — `pri-181-humano.md`

- Sentido de negócio — custo (cadeia parada / retrabalho), qualidade (“aprovo” genérico ≠ autoridade), o que muda (ou não) no dia a dia.
- O quê — o “aprovo” solto não cobre; o que isto não é (não aplica reconciliação, não libera implementação, não fecha issue).
- Por quê / Quando / Próximos passos.
- Decisões — só as que bloqueiam o próximo passo.
- Se precisar de sigla (P1, C1+, RRC), explicar em português simples na 1ª vez.
- Linkar a parte técnica.

### 2) Técnica — `pri-181-next-actions-legivel.md` (ou reescrita do denso)

- O que foi achado em português claro antes de listas de IDs.
- Por que importa.
- Glossário inline na 1ª ocorrência (P1, C1+, DB-16b, RRC, RR-0x…).
- Só então o pacote de itens / reply mínimo / hashes.

Não invente que o pacote já foi APPLIED ou que a issue está Done. Espelhe o espírito de `references/pri-181-humano.md`.
