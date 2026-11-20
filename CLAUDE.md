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
10. Merge é sempre do Richard, com uma exceção: com `MERGE_LEVE` ligado, o bot do GitHub Actions mescla o PR `processo:leve`, fora de draft, que só toca caminhos da lista `mergeLeve` de `.github/processo.json` na `main` e tem todos os checks verdes. O `/pri-pr` abre fora de draft só esse Leve elegível (com a flag desligada, o bot só simula); todo o resto abre em draft. O draft é a trava: para segurar um Leve elegível, converta o PR para draft. Agente nunca mescla. Use "Refs", nunca "Fixes".
11. Leve/Médio: mesclar é aceitar. A issue vai para Done quando o último PR dela é mesclado e não há filha aberta; a evidência continua obrigatória no PR. Alto: Done só com aceite do Richard.
12. In Review é a fila "Com o Richard": esperando decisão, aceite ou AUTORIZO dele, e nada mais. Limite de 3 itens. Fila cheia: não abra trabalho novo que vá precisar dele, e diga isso.
13. Issue nova só nasce de fatia do roadmap, defeito ou pedido do Richard. Não crie issue de "Avaliar", "Planejar" ou "Design" por conta própria; ideia vira uma linha de comentário na issue da fatia em curso (exceção à regra 3).

## Fluxo de desenvolvimento (agent-skills)

O Prisma se desenvolve com as skills do plugin agent-skills (requisito: plugin `agent-skills` instalado), carregadas pelos comandos do repo em `.claude/skills/pri-*`, que trazem os ajustes do Acordo. Não use direto `/agent-skills:spec`, `:plan`, `:build` ou `:ship`: eles gravam na raiz, param para aprovação e abrem revisores extras. O grafo de `.claude/commands/` (`/plan`, `/implement`, `/review`, `/test`, `/verify`, `/commit`, `/fetch-ticket`) e os subagentes de `.claude/agents/` são templates da plataforma para o fluxo do consumidor, lidos pelo watcher, e não se usam aqui.

`/pri-start PRI-NNN` → (Médio e Alto) `/pri-spec` (Médio só se precisar; Alto sempre, aprovada pelo Richard) → (Médio e Alto) `/pri-plan` → (Médio e Alto) Richard aprova o plano → `/clear` → `/pri-build` (o Leve vai direto do `/pri-start` ao `/pri-build`) → `/pri-check` → (Alto) pedido do `/pri-autorizo` → `/pri-pr` → (Alto) AUTORIZO e bump → `/pri-autorizo PRI-NNN readback`. Diagrama: [`docs/fluxo-dev.md`](docs/fluxo-dev.md).

- Spec, plano e todo ficam em `tasks/fN-M-<nome>/` ou `tasks/pri-NNN/`. Nada de `SPEC.md` na raiz.
- Médio e Alto param no plano: o Richard aprova o `todo.md` antes do `/pri-build`; o Leve segue direto (D-FLX-01, 17/11/2026, substitui a D-a no plano). O Médio continua sem parar na spec.
- No `/pri-build`, cada tarefa roda num subagente novo, uma por vez, em contexto limpo (sonnet no Leve, opus no Médio e Alto). A sessão principal só coordena e confere.
- Modelo por passo: `/pri-start` e `/pri-pr` em sonnet, `/pri-spec` e `/pri-plan` em opus (cabeçalho `model:` da skill, vale só no turno dela); build e revisão escolhem pelo nível.
- A revisão é sempre por subagente em contexto limpo (`agent-skills:code-reviewer`; no Leve, com `model: "sonnet"`, D-b, 16/11/2026).
- Testes na raiz: `npm run test:changed` durante o build, `npm test` (receita oficial) e `npm run check` no `/pri-check`. Nunca `npm test` dentro de `scripts/` ou `dashboard/`. A prova de testes no PR é o run da CI.
- Skill nova em `.claude/skills/` precisa de `disable-model-invocation: true`, e nenhum agente do fluxo de desenvolvimento vai para `.claude/agents/`: o watcher abre o consumidor com `--add-dir` deste repo, e o Claude Code carrega `skills`, `commands` e `agents` de diretórios adicionados.

## Onde está o resto

- Fonte: [Prisma — Acordo de desenvolvimento (v2)](https://linear.app/prisma-app/document/prisma-acordo-de-desenvolvimento-62a84790f75a).
- PR: use `.github/pull_request_template.md`. O check `processo-check` exige um rótulo `processo:leve|medio|alto` e a seção Evidência preenchida; no leve, também barra SPEC/handoff/evidence novo e mais de 400 linhas.
- Aviso cedo local: grave o nível da sessão em `.prisma/level` (`leve`, `medio` ou `alto`; o diretório é ignorado pelo git). Com `leve`, o hook `.claude/hooks/processo-level.mjs` nega criar SPEC, handoff ou evidence. Na mesma condição, `.claude/hooks/pri-fluxo.mjs` nega `gh pr create` sem o `check.json` do `/pri-check` no HEAD, nega `git commit` e `git push` em branch cujo PR já foi mesclado ou fechado, nega escrita aos subagentes revisores e bloqueia os comandos do grafo. Os hooks são contornáveis; a barreira real é o CI, que no alto também exige Rollback, Readback e a SPEC citada.
- Onde mora cada coisa: SPEC da fatia (`tasks/<pasta>/SPEC.md`, efêmera, vai para `docs/historico/` ao fechar), spec viva (`docs/capacidades/<id>.md`, o comportamento da capacidade), ADR (`docs/adr/`, decisão de arquitetura já tomada) e `roadmap/DECISOES.md` (decisões de roadmap).
- Roadmap de entrega (proposta até o Richard aprovar): [`ROADMAP.md`](ROADMAP.md) e [`roadmap/`](roadmap/README.md). Trabalho de fatia cita o ID (`F1.2`) na issue, na branch e no PR; fase só abre com o critério de saída da anterior.
- Instruções do repositório (arquitetura, separação plataforma/consumidor, gates): @AGENTS.md
