---
id: dashboard
tipo: fluxo
resumo: Painel local do Espectro, com Runs, custo, PRs, tickets, roteamento e pedidos de autorização, mais preview e checkout local.
situacao: ligada
spec: sem-spec
flags: [PRISMA_DASHBOARD_READONLY]
modulos:
  - dashboard/*
  - scripts/preview-manager.js
  - scripts/preview-gruntfile.js
  - scripts/local-checkout.js
---

# Dashboard

O `dashboard/server.js` é um servidor HTTP local que lê as Runs (`state.json`, custo,
transcrições) e as expõe em telas de `dashboard/public/`: lista de Runs, grafo, custo, PRs,
tickets do Redmine, roteamento, saúde do watcher e aprovação humana. As ações de escrita
passam pelos mesmos escritores das outras capacidades; o painel não tem estado próprio.
Com `PRISMA_DASHBOARD_READONLY=1`, as escritas são recusadas.

O preview sobe o ambiente de um ticket (um por vez, em porta fixa), e o checkout local põe os
repositórios principais no commit do worktree da Run. Os dois moram em `scripts/`, mas só o
painel os chama.

Este mapa trata o painel como uma capacidade só; dividir por tela é assunto da C2.

## Por onde começar

1. [`dashboard/server.js`](../../dashboard/server.js): as rotas da API e a regra de somente leitura.
2. [`dashboard/public/runs-main.js`](../../dashboard/public/runs-main.js): a tela principal de Runs.
3. [`dashboard/README.md`](../../dashboard/README.md): como subir o painel e o que cada tela faz.
4. [`scripts/preview-manager.js`](../../scripts/preview-manager.js): o preview de ambiente e seus processos.
5. [`scripts/local-checkout.js`](../../scripts/local-checkout.js): "usar na minha máquina" e como desfaz.
