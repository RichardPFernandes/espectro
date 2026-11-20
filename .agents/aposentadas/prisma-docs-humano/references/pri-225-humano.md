# PRI-225 — auditoria pronta para você aceitar ou pedir revisão

## O quê

A auditoria Codex foi relida no Cursor: cinco pontos divergem das regras humanas, cinco ficam inconclusivos (falta prova no Mac), zero estão conformes. Os achados graves (redecisão após falha, supersessão sem cercar efeito, contexto pós-decisão frágil) estão confirmados por leitura de código.

Isto **não** fecha a issue, **não** é Approval de produto, **não** muda regras humanas da reconciliação, Roadmap nem código, e **não** troca quem pode gravar decisões.

## Por quê

**Qualidade:** sem aceite (ou pedido de revisão) seu, os achados graves não seguem para a reconciliação humana (PRI-17) — o risco fica documentado e parado.  
**Custo:** seguir como se estivesse “aprovado” gastaria ciclos de build em cima de uma auditoria ainda sem decisão.  
**Dia a dia:** nada muda no produto até você aceitar ou pedir revisão; a prova byte a byte no Mac é opcional e só se você precisar antes de aceitar.

## Quando

Agora — a review Cursor já está pronta. Aceite ou peça revisão **antes** de qualquer follow-up de build nesta fatia. Encaminhar achados graves à PRI-17 só faz sentido **depois** do aceite e fica **fora** desta auditoria.

## Próximos passos

1. Ler o parecer técnico (link no fim).
2. Aceitar a matriz/achados **ou** pedir revisão (com ou sem custódia Mac).
3. Se aceitar: encaminhar os três achados graves à reconciliação humana (PRI-17).

## Decisões (só se bloquearem o próximo passo)

- **Aceita** a matriz e os achados confirmados? *(bloqueia encaminhar à PRI-17)*
- **Aceita** que o “outro runtime” desta fatia foi Cursor (não Claude), conforme sua ordem?
- **Quer revisar** antes pedindo a custódia Mac? *(só se precisar prova byte a byte)*

---

Técnico: [`pri-225-cursor-review.md`](./pri-225-cursor-review.md) · Issue: [PRI-225](https://linear.app/prisma-app/issue/PRI-225)
