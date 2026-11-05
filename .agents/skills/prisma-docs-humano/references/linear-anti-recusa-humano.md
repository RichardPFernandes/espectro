# Anti-recusa — o que puxar agora

## O quê

A alavanca útil no board Linear é a cadeia **181 → 184 → 207 → 86/198**, com a PRI-225 só como auditoria de suporte — não é a prioridade Linear genérica. Isto **não** muda status Linear, **não** inventa Approval, **não** aplica reconciliação (RRC / Architecture Change Candidate) e **não** promove Active.

## Por quê

Sem confirmação P1 explícita na PRI-181 não há C1+ (próxima fase de implementação). A PRI-184 (retry bloqueado) é fatia pequena de alto retorno no board. A PRI-207 tem HOW (desenho operacional) aprovado, mas implementação exige issue separada. PRI-86 / PRI-198 andam em paralelo leve; 86 já aceitou “manter + adiar” no ciclo 1. Planejar/RFC/E2E/TS (104, 240, 135, 133, 150, 134, 136, Self-SDD 174) não devem competir com esse núcleo.

## Quando

Ordem atual: **181** (P1 agora) → **184** (tornar retry visível) → **207** (HOW fechado; build depois) → **86/198** (paralelo leve) → **225** (aceite/REVISE da auditoria; não é build). Itens fora do núcleo ficam na fila sem puxar atenção agora.

## Próximos passos

1. **PRI-181** — confirmação P1 explícita (sem isso não há C1+) → [`pri-181-humano.md`](./pri-181-humano.md)
2. **PRI-184** — tornar visível o retry bloqueado no board.
3. **PRI-207** — manter HOW aprovado; implementação = issue separada quando autorizar → [`pri-207-humano.md`](./pri-207-humano.md)
4. **PRI-86 / PRI-198** — avaliação em paralelo leve → [`pri-86-humano.md`](./pri-86-humano.md)
5. **PRI-225** — aceite/REVISE da auditoria → [`pri-225-humano.md`](./pri-225-humano.md)

## Decisões (só se bloquearem o próximo passo)

- **181:** confirma P1 com pacote recomendado? *(bloqueia C1+ e o avanço da cadeia)* — demais asks só quando forem o próximo passo da respectiva issue.

---

Board completo: [`linear-issues-status.md`](./linear-issues-status.md)
