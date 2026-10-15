---
name: prisma-issue
description: Abre uma issue PRI-NNN do Linear para trabalho interativo no repositório Prisma — lê issue, handoff e baselines, delimita escopo e arquivos e propõe um plano antes de editar. Use quando o usuário citar uma issue PRI ou pedir para começar uma tarefa no Prisma.
disable-model-invocation: true
---

# prisma-issue

Ponto de partida de uma sessão interativa no Prisma. Só lê e planeja; não edita código nem estado.

## Passos

1. Leia `AGENTS.md` e a regra `.cursor/rules/interactive-boundary.mdc`.
2. Pelo MCP `linear-prisma`, recupere a issue informada (ex.: `PRI-168`), seus comentários, issues relacionadas e o handoff anexado, se houver.
3. Identifique as baselines e decisões citadas e abra as que existirem no repo (`provenance/`, `docs/`, `.graph/`).
4. Entregue um resumo curto:
   - objetivo e critério de aceite da issue;
   - escopo: arquivos e pacotes (`scripts/`, `dashboard/`, `harness/`, `templates/`, `docs/`) que devem mudar e os que não podem;
   - riscos de contrato (schemas em `.graph/schemas/`, `state-writer.js`, proveniência);
   - plano em passos pequenos, cada um com o teste que o comprova.
5. Sugira a branch no padrão `fernandesrichard312/pri-NNN-<slug>` a partir de `main`.
6. Pare e espere aprovação do plano antes de editar.

## Fora do escopo

- Avançar nó do grafo, gravar `state.json`, `spec_hash`, aprovação, invalidação, lock ou handoff oficial.
- Rodar `scripts/state-writer.js` ou `scripts/invalidate.js` contra um consumidor.
- Commit, push ou PR sem aprovação explícita.
