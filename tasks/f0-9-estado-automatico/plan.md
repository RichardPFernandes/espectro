# Plano F0.9 AC-01 (PRI-399, Médio)

Escopo desta entrega: só o AC-01. AC-02 (Action no merge, secret `LINEAR_API_KEY`) e AC-03
(relatório semanal) ficam para PRs seguintes.

**AC-01.** O `/pri-pr` atualiza Estado e Próximo passo da issue ao abrir o PR e, quando o PR é
o último da fatia, marca a fatia `concluída` no `FASE.md` no mesmo PR. `roadmap-lint` verde.

**Mudança.** Só texto: `.claude/skills/pri-pr/SKILL.md` e `roadmap/fase-0-destravar/FASE.md`.
Nada roda numa Run, sem flag a ligar ("não se aplica").

**Cuidado de ordem.** O hook `pri-fluxo.mjs` exige `check.json` no HEAD. Um commit do `FASE.md`
dentro do `/pri-pr` muda o HEAD; a skill manda refazer o `/pri-check` nesse caso.

**Prova.** `node scripts/lib/roadmap-lint.js` e `node --test .github/scripts/skills-flag.test.mjs`
verdes; CI no SHA final; revisão `agent-skills:code-reviewer` (opus, contexto limpo).
