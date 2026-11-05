# PRI-225 — auditoria Cursor pronta para aceite

## O quê

A auditoria Codex foi relida no Cursor: matriz **5 divergentes / 5 inconclusivos / 0 conformes**, com achados F-01…F-05 confirmados por leitura de código. Isto **não** fecha a issue, **não** é Approval de produto, **não** muda PHI (Policy / Human Invariants da reconciliação), Roadmap nem código, e **não** promove a PRI-180 a writer. O writer DS-09 (decisão de writer único / Decision imutável) físico continua na PRI-231.

## Por quê

Sem aceite (ou pedido de revisão) humano, os achados graves (F-01, F-02, F-04 — redecisão após falha, supersessão sem cercar efeito, contexto pós-decisão frágil) não seguem para a reconciliação humana (PRI-17). O pacote de prova Mac desta rodada está ausente: claims só de probe ficam inconclusivos por reprodução; o diagnóstico de código dos achados foi confirmado por leitura.

## Quando

Agora — a review Cursor já está pronta. Aceite ou REVISE **antes** de tratar qualquer follow-up de build nesta fatia. Encaminhar achados graves à PRI-17 é **fora** desta auditoria e só faz sentido **depois** do aceite. Prova byte a byte (custódia Mac: probes + hashes) é opcional e só se você precisar antes de aceitar.

## Próximos passos

1. Ler o parecer técnico (link no fim).
2. Aceitar a matriz/achados **ou** pedir revisão (com ou sem custódia Mac).
3. Se aceitar: encaminhar F-01, F-02, F-04 à reconciliação humana (PRI-17).

## Decisões (só se bloquearem o próximo passo)

- **Aceita** a matriz Codex e os achados F-01…F-05 confirmados? *(bloqueia encaminhar à PRI-17)*
- **Aceita** que o “outro runtime” desta fatia foi Cursor (não Claude), conforme sua ordem?
- **Quer revisar** antes do aceite pedindo a custódia Mac? *(só se precisar prova byte a byte)*

---

Técnico: [`pri-225-cursor-review.md`](./pri-225-cursor-review.md) · Issue: [PRI-225](https://linear.app/prisma-app/issue/PRI-225)
