> Gate do plano dispensado pelo Richard no pedido da sessão de 17/11/2026 ("Médio segue sem parar para aprovar plano"). Não houve aprovação do plano.

# Tarefas PRI-399 (AC-01)

- [x] **T1: `/pri-pr` atualiza Estado/Próximo passo e marca a fatia `concluída` (AC-01)** · S
  - Aceite: a skill diz o que escrever em Estado e Próximo passo ao abrir o PR; define "último PR da fatia"; manda marcar `concluída` no `FASE.md` no mesmo PR, com `roadmap-lint`; trata o HEAD novo (refazer `/pri-check`).
  - Verificar: `node scripts/lib/roadmap-lint.js`; `node --test .github/scripts/skills-flag.test.mjs`.
  - Arquivos: `.claude/skills/pri-pr/SKILL.md`
  - Depende de: nada

- [x] **T2: FASE.md da Fase 0, linha da F0.9 (AC-01)** · XS
  - Aceite: "sem issue" vira PRI-399 e o status vira `em andamento`; `roadmap-lint` verde.
  - Arquivos: `roadmap/fase-0-destravar/FASE.md`
  - Depende de: nada
