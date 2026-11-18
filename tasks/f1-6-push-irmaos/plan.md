# F1.6: plano (PRI-179, Alto)

Entrada: `SPEC.md` desta pasta, aprovada em 18/11/2026 (D-PRI-179-01: Q1 = sim, Q2 = sem flag).

## Decisões de implementação

- **Tudo no script.** A chave nasce em `scripts/git-push-effect.sh`; o `dom06-attempt.js` não muda
  (ele já compara só `fulfilled` e aceita `--status failed`).
- **Formato da chave:** `push:<toplevel real>@<sha do commit enviado>:<args do git>`. O detalhe do
  efeito leva a mesma chave, para a linha de pulo dizer repo e commit.
- **Diretório efetivo:** um `-C <dir>` antes de `push` é tirado dos argumentos e vira o diretório
  do git e da identidade; sem ele, o cwd. Toplevel por `git -C <dir> rev-parse --show-toplevel`,
  canonizado com `cd … && pwd -P` (resolve symlink e `/var` → `/private/var` no macOS).
- **Commit enviado:** origem do último refspec depois do remote (sem `+`, antes de `:`); sem
  refspec, `HEAD`. Resolvido com `git rev-parse --verify <origem>^{commit}`; se não resolve, sai ≠ 0
  antes de autorizar. Refspec de remoção (`:branch`) usa o literal `delete` no lugar do sha.
- **Testes:** `scripts/git-push-effect.test.js` (node:test), repos temporários e remotes bare em
  `os.tmpdir()`, Attempt criado com `beginAttempt`. Roda no `npm test` da raiz.

## Ordem

T1 (repo na chave, `-C`, fora de repo) → T2 (commit na chave, linha de pulo, teste da PRI-94) →
T3 (falha gravada, spec viva) → checkpoint. Sequencial: as três mexem no mesmo script.

## Riscos

| Risco | Efeito | Mitigação |
| -- | -- | -- |
| Parse de argumentos do git (opções com valor, como `--push-option x`) escolhe o refspec errado | Médio: sha errado na chave | Testes com `-u`, `--force-with-lease`, `HEAD:<branch>`; na dúvida, `HEAD` |
| Attempt em andamento no bump com chave antiga | Baixo: um push a mais, sem efeito | Aceito na SPEC (Fora de escopo) |
| Mudar a expectativa do teste da PRI-94 esconde regressão | Médio | Só a asserção do remote e a contagem de efeitos de push mudam; PR, Redmine e revogação ficam iguais |
