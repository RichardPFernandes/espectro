# Eval 01 — reescrever review densa (sempre duas partes)

Você é um agente no Project Prisma. Acione a skill `prisma-docs-humano`.

**Regra:** SEMPRE (1) parte de negócio **e** (2) parte técnica. Só um dos dois = falha.

## Tarefa

O arquivo técnico abaixo (trecho estilo `pri-225-cursor-review.md`) é ilegível para Richard: siglas sem contexto e matriz antes da prosa.

1. **Negócio** — `pri-225-humano.md`:
   - sentido de negócio (custo, qualidade, o que muda no dia a dia);
   - O quê / Por quê / Quando / Próximos passos;
   - Decisões só se bloquearem o próximo passo;
   - jargão/siglas evitados ou explicados em português simples;
   - link para a parte técnica.
2. **Técnica** — `pri-225-cursor-review-legivel.md` (ou reescreva o técnico):
   - abertura “o que foi achado” em português claro **antes** de qualquer matriz;
   - por que importa (consequência / risco / custo de ignorar);
   - glossário inline na 1ª ocorrência (PHI, DS-09, DIVERGENT, F-01, RRC, etc.);
   - só então a matriz resumida.

Não invente Approval, Done ou APPLIED. Não apague o sentido do diagnóstico (5 divergentes / 5 inconclusivos / 0 conformes; F-01/F-02/F-04 graves).

## Trecho denso de entrada

```markdown
## Veredito
**APPROVE_FOR_HUMAN_DECISION**
A auditoria Codex v1 é tecnicamente sólida (código + PHI + DS-09). Findings F-01…F-05 no código da main fixada. Matriz 5 DIVERGENT / 5 INCONCLUSIVE / 0 COMPLIANT. DS-09 permanece DIVERGENT como candidato a executor — sem promover PRI-180 a writer.
Integridade PARCIAL: probes Mac ausentes → claims de probe INCONCLUSIVE por reprodução.

## Matriz PHI-01…10
| PHI | Cursor | Motivo curto |
| 01 | DIVERGENT | DECIDABLE inclui failed/uncertain; reject/markManual reaceitam no mesmo AUTH-id. F-01. |
| 02 | DIVERGENT | requestAuthorization supersede failed/uncertain; chave db-apply muda. F-02. |
```

Compare o espírito com `references/pri-225-humano.md` e `references/pri-225-cursor-review-legivel-excerpt.md`.
