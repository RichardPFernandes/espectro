## Regras de processo (Acordo v2) — leia antes de qualquer tarefa
1. Toda issue tem rótulo `Processo: Leve|Médio|Alto`. Sem rótulo, pare e pergunte.
2. Status mora no topo da descrição da issue (Estado / Próximo passo / Decisão pendente / Ligado ao fechar / Nível). Edite no lugar; não poste status em comentário.
3. Comente só para registrar decisão ou bloqueio, em 3 linhas: Decisão|Bloqueio / Por quê ou quem decide / Efeito.
4. Nunca repita invariantes ("RC-x NOT APPLIED", "polling não tocado"). Eles ficam listados uma vez nas Agent notes.
5. Leve: issue + PR. Médio: + SPEC ≤ 1 página, se necessário. Alto: + SPEC de 1–2 páginas. Nunca handoff yaml nem evidence.md separado; a evidência vai no PR.
6. Revisão: Leve = 1 revisão; Médio = 1 G3; Alto = 1 rodada G3 com 2 revisores. Segunda rodada só com decisão do Richard.
7. Nível pelo efeito: atrás de flag desligada é Médio; mudar o que já roda no consumidor (ligar flag, bump, polling, operação protegida, credencial) é Alto. Se o trabalho passar do nível, peça reclassificação. Não crie adendo.
8. Pare e peça decisão só quando mudar o escopo, faltar acesso/credencial ou a ação não tiver volta. Sempre com recomendação. Leve/Médio: sem objeção até a janela de segunda ou quinta, vale a recomendação.
9. Toda fatia termina em algo ligado ou demonstrável; "flag reservada" sem gatilho não é Pronto.
10. Merge é sempre do Richard. PR em draft. Use "Refs", nunca "Fixes".

## Onde está o resto

- Fonte: [Prisma — Acordo de desenvolvimento (v2)](https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a).
- PR: use `.github/pull_request_template.md`. O check `processo-check` exige um rótulo `processo:leve|medio|alto` e a seção Evidência preenchida; no leve, também barra SPEC/handoff/evidence novo e mais de 400 linhas.
- Aviso cedo local: grave o nível da sessão em `.prisma/level` (`leve`, `medio` ou `alto`; o diretório é ignorado pelo git). Com `leve`, o hook `.claude/hooks/processo-level.mjs` nega criar SPEC, handoff ou evidence. O hook é contornável; a barreira real é o CI.
- Instruções do repositório (arquitetura, separação plataforma/consumidor, gates): @AGENTS.md
