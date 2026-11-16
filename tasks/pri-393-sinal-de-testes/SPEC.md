# SPEC PRI-393: sinal confiável da suíte de testes

> **Fatia:** fora do mapa (pedido do Richard em 16/11) · **Issue:** PRI-393 · **Nível:** Médio (muda o harness e a CI que toda rodada de teste usa, sem efeito no consumidor)
> **AUTORIZO:** não precisa · **Flag:** nenhuma
> **Decisões citadas:** nenhuma · **Código lido em:** `main` `73a5dba`

## Contexto (AS-IS)

Medido em 16/11, Node 24.22.1, macOS: 2.408 + 615 testes, 220 s, 2 falhas.

- No Mac o `npm test` fica vermelho: o teste compara caminho sem `realpath`, e `/var` é link para `/private/var` (`scripts/lib/qa-rejection-c0-oracle.test.js:204`). A CI só roda em Linux.
- O Node local padrão é 20.20.2, fora de suporte desde 30/04/2026. O runbook cita o 20 como referência (`docs/runbook.md:88`), o README cita 22 ou 24 (`README.md:173`), e não há `.nvmrc` nem `engines`.
- `scripts/validate-handoff.test.js` (613 linhas) está excluído por um caminho fixo (`scripts/validate-handoff.test.js:147`, `harness/test-exclusions.json`).
- O `processo-check` lista 5 arquivos e roda 3: o checkout esparso não traz `scripts/lib`, e `node --test` sai com 0 para arquivo ausente (`.github/workflows/processo-check.yml:45`). São 30 testes de 96.
- `check:js` e ESLint não rodam em nenhum workflow. Estão verdes hoje.
- A suíte grava dentro do checkout: `logs/state-conflicts.jsonl`, `scripts/dist/`, `dashboard/dist/` (`scripts/cas.js:449`).
- `test:changed` só acha o vizinho de mesmo nome: `dashboard/server.js` roda 1 dos 38 testes de API; `scripts/cas.js` e `scripts/readmine-watcher.js` não rodam nada (`harness/test-changed.js:12`).
- O runner não tem tempo limite (`harness/run-tests.js:106`): teste travado só morre nos 15 minutos do job.

## Objetivo

Quando a fatia fecha, verde significa que tudo o que deveria rodar rodou e passou, no Mac e no Linux, e vermelho aponta um teste pelo nome. Nenhum teste é pulado em silêncio, a suíte não deixa arquivo no checkout e um teste travado falha em minutos.

## Não inclui

- Testkit compartilhado, receita única chamada pela CI e medição de cobertura (itens 9 a 11 da validação; outra issue, se o Richard pedir).
- Corrigir a resolução do log em `scripts/cas.js` (PRI-372). Aqui entra só a guarda que detecta a escrita.
- Separar testes unitários de integração, ou mudar o layout de pastas.
- Acelerar `scripts/lib/routing-off-golden.test.js` (43 s na CI).

## Critérios de aceite

- AC-01: `npm test` passa no macOS e no Linux em Node 24, pela receita oficial.
- AC-02: `.nvmrc` e `engines` declaram a versão de Node; README e runbook citam a mesma; com Node mais antigo, `npm test` recusa com mensagem que diz a versão exigida.
- AC-03: `scripts/validate-handoff.test.js` sai de `harness/test-exclusions.json` e passa na receita.
- AC-04: arquivo de teste listado que não existe, ou execução com zero testes, faz o comando falhar, no harness e no `processo-check`.
- AC-05: a CI roda `check:js` de `scripts` e `dashboard` e o `lint:src`, e falha quando um deles falha.
- AC-06: a receita compara o checkout antes e depois da suíte e falha, listando os caminhos, se algo foi criado ou alterado fora de `node_modules/`.
- AC-07: `npm run test:changed` roda a suíte dashboard inteira para qualquer mudança em `dashboard/`, e avisa por nome cada arquivo alterado em `scripts/` que não tem teste par.
- AC-08: teste que passa de 120 s é interrompido e aparece como falha com nome no TAP e no resumo do job.

## Como se demonstra

- AC-01: link do job verde nos dois sistemas, ou saída local do `npm test` no Mac mais o job Linux.
- AC-02: `nvm use 20 && npm test` → exit 2 com a mensagem.
- AC-03 a AC-08: cada um tem teste em `harness/*.test.js` que falha sem a mudança (teste primeiro). Para AC-04 e AC-06, um caso sintético: arquivo inexistente, e teste que grava no checkout.
- Evidência na seção Evidência do PR: tabela por AC com a saída do teste e o link da CI.

## Fica ligado?

- Sim: ligado na `main` ao mesclar. Vale para toda rodada de `npm test` e para a CI. Não toca o consumidor.

## Riscos e perguntas abertas

- AC-06 pode quebrar a suíte de quem tem `dist/` ou `logs/` antigos: a guarda compara antes e depois, não exige checkout limpo. Os testes que hoje gravam `dist/` passam a gravar no TMPDIR.
- AC-08: 120 s é folga de 2 vezes sobre o teste mais lento medido (56 s no Mac). Se a CI oscilar, sobe-se o limite, não se remove.
- Pergunta (Richard): Postgres na CI para os 4 testes de `db-effect-pg` que sempre pulam? Recomendo sim, em PR separado desta issue, por mudar a CI de forma maior.
- Pergunta (Richard): matriz da CI passa a 24 e 26, saindo o 22? Recomendo manter 22 e 24 agora e trocar em abril de 2027, quando o 22 sai de suporte.
- Pergunta (Richard): o e2e da PRI-69 (6 de 11 cenários falhando) continua excluído? Recomendo sim; investigar é outra issue.
