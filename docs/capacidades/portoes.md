---
id: portoes
tipo: capacidade
resumo: Conferências entre nós do fluxo, como plano, build, churn, revisão, evidência dos ACs e UI.
situacao: ligada
spec: sem-spec
flags: [PRISMA_UI_VERIFY]
modulos:
  - scripts/lib/plan-scorer.js
  - scripts/lib/build-validator.js
  - scripts/lib/pre-build-ai-fix.js
  - scripts/lib/churn-detector.js
  - scripts/lib/review-result.js
  - scripts/lib/acceptance-evidence.js
  - scripts/lib/openapi-validator.js
  - scripts/lib/service-detector.js
  - scripts/lib/ui-verify-verdict.js
  - scripts/ui-verify.js
---

# Portões

Portão é a conferência que o watcher faz entre dois nós antes de despachar o seguinte. O
`plan-scorer.js` dá nota ao plano por heurística, sem LLM, e manda refazer ou escalar para
humano. O `build-validator.js` roda `mvn compile` antes do `implement`, e o `churn-detector.js`
conta quantas rodadas mexeram no mesmo arquivo. O `review-result.js` guarda o veredito da revisão
em duas dimensões, e o `acceptance-evidence.js` mostra, por AC, como ele foi implementado e testado.

Plano, build e churn não têm flag. A verificação de UI é opcional: `PRISMA_UI_VERIFY` vem
desligada e, sem ela, o veredito é `SKIPPED`. O portão de spec está em `spec`.

## Por onde começar

1. [`scripts/lib/plan-scorer.js`](../../scripts/lib/plan-scorer.js): os cinco critérios da nota do plano.
2. [`scripts/lib/build-validator.js`](../../scripts/lib/build-validator.js): a base compila? É só compilar, nunca testar.
3. [`scripts/lib/churn-detector.js`](../../scripts/lib/churn-detector.js): os snapshots em `refs/churn/*` e a contagem.
4. [`scripts/lib/review-result.js`](../../scripts/lib/review-result.js): as duas dimensões e quando o resultado é PASS.
5. [`docs/ui-verify.md`](../ui-verify.md): a verificação de UI, desligada por padrão.
