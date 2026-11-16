## Regras de processo (Acordo v2) — leia antes de qualquer tarefa
1. Toda issue tem rótulo `Processo: Leve|Médio|Alto`. Sem rótulo, pare e pergunte.
2. Status mora no topo da descrição da issue (Estado / Próximo passo / Decisão pendente / Ligado ao fechar / Nível). Edite no lugar; não poste status em comentário.
3. Comente só para registrar decisão ou bloqueio, em 3 linhas: Decisão|Bloqueio / Por quê ou quem decide / Efeito.
4. Nunca repita invariantes ("RC-x NOT APPLIED", "polling não tocado"). Eles ficam listados uma vez nas Agent notes.
5. Leve: issue + PR. Médio: + SPEC ≤ 1 página, se necessário. Alto: + SPEC de 1–2 páginas. Nunca handoff yaml nem evidence.md separado; a evidência vai no PR.
6. Revisão: Leve = 1 revisão; Médio = 1 G3; Alto = 1 rodada G3 com 2 revisores. Segunda rodada só com decisão do Richard.
7. Nível pelo efeito: atrás de flag desligada, ou piloto no launcher do próprio Espectro, é Médio; mudar o que já roda no consumidor corporativo (ligar flag, bump, polling, operação protegida, credencial) é Alto. Se o trabalho passar do nível, peça reclassificação. Não crie adendo.
8. Pare e peça decisão só quando mudar o escopo, faltar acesso/credencial ou a ação não tiver volta. Sempre com recomendação. Leve/Médio: sem objeção até a janela de segunda ou quinta, vale a recomendação.
9. Toda fatia termina em algo ligado ou demonstrável; "flag reservada" sem gatilho não é Pronto.
10. Merge é sempre do Richard. PR em draft. Use "Refs", nunca "Fixes".
11. Leve/Médio: mesclar é aceitar. A issue vai para Done quando o último PR dela é mesclado e não há filha aberta; a evidência continua obrigatória no PR. Alto: Done só com aceite do Richard.
12. In Review é a fila "Com o Richard": esperando decisão, aceite ou AUTORIZO dele, e nada mais. Limite de 3 itens. Fila cheia: não abra trabalho novo que vá precisar dele, e diga isso.
13. Issue nova só nasce de fatia do roadmap, defeito ou pedido do Richard. Não crie issue de "Avaliar", "Planejar" ou "Design" por conta própria; ideia vira uma linha de comentário na issue da fatia em curso (exceção à regra 3).

## Fluxo de desenvolvimento (agent-skills)

Desenvolver o Prisma usa os comandos do plugin agent-skills, sempre com prefixo, mais três skills do repo que encaixam o Acordo. O grafo de `.claude/commands/` (`/plan`, `/implement`, `/review`, `/test`, `/verify`, `/commit`, `/fetch-ticket`) e os subagentes de `.claude/agents/` são do consumidor, lidos pelo watcher, e não se usam aqui.

`/pri-start PRI-NNN` → (Médio/Alto) `/agent-skills:spec` e `/agent-skills:plan` → `/agent-skills:build` → `/pri-check` → `/pri-pr` → (Alto, depois do AUTORIZO) `/agent-skills:ship`.

- Spec, plano e todo ficam em `tasks/fN-M-<nome>/` ou `tasks/pri-NNN/`; passe o caminho aos comandos. Nada de `SPEC.md` na raiz.
- A suíte completa roda pela receita oficial (`/pri-check`), nunca com `npm test` cru.
- A revisão é sempre por subagente em contexto limpo (`agent-skills:code-reviewer`), não no mesmo contexto.

## Onde está o resto

- Fonte: [Prisma — Acordo de desenvolvimento (v2)](https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a).
- PR: use `.github/pull_request_template.md`. O check `processo-check` exige um rótulo `processo:leve|medio|alto` e a seção Evidência preenchida; no leve, também barra SPEC/handoff/evidence novo e mais de 400 linhas.
- Aviso cedo local: grave o nível da sessão em `.prisma/level` (`leve`, `medio` ou `alto`; o diretório é ignorado pelo git). Com `leve`, o hook `.claude/hooks/processo-level.mjs` nega criar SPEC, handoff ou evidence. O hook é contornável; a barreira real é o CI.
- Roadmap de entrega (proposta até o Richard aprovar): [`ROADMAP.md`](ROADMAP.md) e [`roadmap/`](roadmap/README.md). Trabalho de fatia cita o ID (`F1.2`) na issue, na branch e no PR; fase só abre com o critério de saída da anterior.
- Instruções do repositório (arquitetura, separação plataforma/consumidor, gates): @AGENTS.md
