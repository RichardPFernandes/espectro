# Anti-recusa — o que puxar agora

## O quê

A alavanca útil no board Linear é a cadeia **181 → 184 → 207 → 86/198**, com a PRI-225 só como auditoria de suporte — não a prioridade Linear genérica.

Isto **não** muda status Linear, **não** inventa Approval, **não** aplica mudança de arquitetura e **não** promove Active.

## Por quê

**Custo:** puxar planejar/RFC/E2E/TypeScript em paralelo com o núcleo gasta atenção e cota sem destravar a anti-recusa.  
**Qualidade:** sem confirmação explícita na PRI-181, a próxima fase de implementação não tem base — “aprovo” genérico não serve.  
**Dia a dia:** a ordem prática é confirmar 181, tornar o retry (184) visível, manter o desenho 207 fechado (build depois), avaliar 86/198 em paralelo leve, e só então o aceite da auditoria 225.

## Quando

Ordem atual: **181** (confirmação agora) → **184** (tornar retry visível) → **207** (desenho fechado; build depois) → **86/198** (paralelo leve) → **225** (aceite/revisão da auditoria; não é build). Itens fora do núcleo ficam na fila sem puxar atenção agora.

## Próximos passos

1. **PRI-181** — confirmação explícita do pacote (sem isso não há fase de implementação) → [`pri-181-humano.md`](./pri-181-humano.md)
2. **PRI-184** — tornar visível o retry bloqueado no board.
3. **PRI-207** — manter desenho aprovado; implementação = issue separada quando autorizar → [`pri-207-humano.md`](./pri-207-humano.md)
4. **PRI-86 / PRI-198** — avaliação em paralelo leve → [`pri-86-humano.md`](./pri-86-humano.md)
5. **PRI-225** — aceite ou revisão da auditoria → [`pri-225-humano.md`](./pri-225-humano.md)

## Decisões (só se bloquearem o próximo passo)

- **181:** confirma o pacote recomendado? *(bloqueia a fase de implementação e o avanço da cadeia)* — demais asks só quando forem o próximo passo da respectiva issue.

---

Board completo: [`linear-issues-status.md`](./linear-issues-status.md)
