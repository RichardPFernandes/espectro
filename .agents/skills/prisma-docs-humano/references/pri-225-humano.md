# PRI-225 — o que fazer agora

**Veredito:** a auditoria Codex foi relida no Cursor e está pronta para você aceitar ou pedir revisão — isto **não** fecha a issue nem autoriza mudança de código.

## Agora

1. Ler o parecer técnico (link no fim).
2. Responder **sim ou não** às perguntas abaixo.
3. Se aceitar: encaminhar os achados graves (F-01, F-02, F-04) à reconciliação humana (PRI-17) — **fora** desta auditoria.

## Decisões (sim / não)

- **Aceita** a matriz Codex (5 divergentes / 5 inconclusivos / 0 conformes) e os achados F-01…F-05 confirmados?
- **Aceita** que o “outro runtime” desta fatia foi Cursor (não Claude), conforme sua ordem?
- **Quer revisar** antes do aceite pedindo a custódia Mac (probes + hashes)? *(só se precisar prova byte a byte)*

## O que isto **não** é

- Não é Approval de produto.
- Não declara Done da PRI-225.
- Não muda PHI, Roadmap nem código.
- Não promove a PRI-180 a writer.

## Opcional (contexto)

- Achados críticos: redecisão após falha, supersessão sem cercar efeito, contexto pós-decisão frágil.
- Pacote de prova Mac ausente nesta rodada → claims só de probe ficam inconclusivos por reprodução; o código dos achados foi confirmado por leitura.
- Writer DS-09 físico continua na PRI-231.

---

Técnico: [`pri-225-cursor-review.md`](./pri-225-cursor-review.md) · Issue: [PRI-225](https://linear.app/prisma-app/issue/PRI-225)
