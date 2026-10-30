# Anti-recusa — o que puxar agora

**Veredito:** a alavanca útil é a cadeia **181 → 184 → 207 → 86/198**, com 225 só como auditoria de suporte — não é a prioridade Linear genérica.

## Agora (ordem)

1. **PRI-181** — confirmação P1 explícita (sem isso não há C1+).
2. **PRI-184** — tornar visível o retry bloqueado no board (fatia pequena, alto retorno).
3. **PRI-207** — HOW aprovado; implementação = issue separada quando autorizar.
4. **PRI-86 / PRI-198** — avaliação em paralelo leve; 86 já aceitou “manter + adiar” no ciclo 1.
5. **PRI-225** — aceite/REVISE da auditoria; não é build.

## Decisões abertas (sim / não)

- **181:** confirma P1 com pacote recomendado? → [`pri-181-humano.md`](./pri-181-humano.md)
- **225:** aceita o parecer Cursor? → [`pri-225-humano.md`](./pri-225-humano.md)
- **86:** Done do ciclo 1 ou deixar aberta para Fatia C? → [`pri-86-humano.md`](./pri-86-humano.md)
- **207:** abrir issue de implementação? → [`pri-207-humano.md`](./pri-207-humano.md)

## Fora do núcleo (não competir)

Planejar/RFC/E2E/TS (104, 240, 135, 133, 150, 134, 136, Self-SDD 174) — manter na fila.

## O que isto **não** faz

- Não muda status Linear.
- Não inventa Approval nem aplica reconciliação.
- Não promove Active.

---

Board completo: [`linear-issues-status.md`](./linear-issues-status.md)
