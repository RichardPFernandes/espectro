# Tarefas F0.9 AC-02: Action no merge

> Plano aprovado pelo Richard em 2026-11-18.

Plano: [`plan.md`](plan.md). Médio: um subagente opus por tarefa, em ordem. Teste de cada tarefa:
`node --test .github/scripts/*.test.mjs` (o `test:changed` não cobre `.github/`). Não rode
`npm test` dentro de `scripts/` ou `dashboard/`. Nenhuma tarefa grava a variável do repo nem usa o
secret de verdade.

## T1: lib pura de decisão (AC-02)

- [ ] **O que:** `.github/scripts/estado-no-merge-lib.mjs`, sem rede nem disco, exportando:
  - `parseRefs(title, body)`: IDs `PRI-N` citados como `Refs PRI-N` (sem distinção de caixa, vários
    por PR, sem repetição). `Fixes`/`Closes` não contam.
  - `levelFromLabels(labels, levels)`: `levels` é o mapa `levels` do `.github/processo.json`; sem
    rótulo ou com mais de um nível devolve `null`.
  - `decide({ level, otherOpenPrs, openChildren })`: `alto` ou `null` → `{ acao: 'nada', motivo }`;
    leve/medio sem pendência → `'done'`; com pendência → `'estado'` (lista o que falta).
  - `rewriteEstado(description, { estado, proximo })`: troca só o texto depois de `**Estado:**` e
    `**Próximo passo:**` (primeira ocorrência de cada); devolve `{ text, changed }`; sem a linha,
    `changed: false` e o texto intacto. Não toca "Decisão pendente" nem o resto.
  - `estadoText({ pr, data, acao, pendencias })`: as frases. Done: Estado `PR #n mesclado em
    AAAA-MM-DD; issue em Done pela Action.` e Próximo passo `nenhum.`; pendência: Estado `PR #n
    mesclado em AAAA-MM-DD.` e Próximo passo `falta <PR #m / filha PRI-k>.`
- [ ] **Teste que falha antes:** `.github/scripts/estado-no-merge-lib.test.mjs` cobre: Refs múltiplos
  e "Fixes" ignorado; rótulo ausente/duplo; Alto → nada; Médio com PR aberto → estado; Leve limpo →
  done; rewrite preserva "Decisão pendente" e o corpo, e não muda nada sem a linha.
- [ ] **Arquivos:** os dois acima. Escopo S.

## T2: CLI com Linear e GitHub injetáveis (AC-02)

Depende de T1.

- [ ] **O que:** `.github/scripts/estado-no-merge.mjs`, com `run({ env, event, linear, gh, summary, now })`
  exportado e um `main` que monta as dependências reais (fetch em `https://api.linear.app/graphql`
  com `LINEAR_API_KEY`; API do GitHub com `GITHUB_TOKEN`; evento de `GITHUB_EVENT_PATH`, ou
  `--pr N` buscando o PR pela API; resumo em `GITHUB_STEP_SUMMARY`, ou stdout).
  - Modo por `ESTADO_NO_MERGE`: ausente/`off` → sai 0 sem chamar `linear` nem `gh`; `simular` → só
    leituras, e o resumo diz o que faria; `on` → escreve.
  - PR não mesclado → nada. Para cada issue de `parseRefs`: lê a issue (descrição, estado, time e
    seus estados, filhas com `state.type`, anexos); "outro PR aberto" = anexo
    `github.com/<GITHUB_REPOSITORY>/pull/<n>` com `n` ≠ PR, e `gh` diz `open`.
  - `done`: um `issueUpdate` com `stateId` (estado `type: completed`, nome `Done`) e `description`
    (se `changed`). `estado`: `issueUpdate` só com `description`. `nada`: nenhuma mutação.
  - Erro numa issue não impede as outras; o processo sai 1 no fim se alguma falhou. O token nunca
    vai para o resumo nem para o log.
- [ ] **Teste que falha antes:** `.github/scripts/estado-no-merge.test.mjs` com `linear` e `gh` falsos
  que registram chamadas: `off` → zero chamadas; `simular` → zero mutações e resumo com a decisão;
  `on` + Médio limpo → uma mutação com `stateId` do Done e descrição nova; `on` + Alto → zero
  mutações; `on` + filha aberta → mutação sem `stateId`; PR fechado sem merge → nada; erro do
  Linear numa issue → a outra ainda é processada e o código de saída é 1.
- [ ] **Arquivos:** CLI e teste; um evento de exemplo em `.github/scripts/fixtures/` se ajudar. Escopo M.

## T3: workflow (AC-02)

Depende de T2.

- [ ] **O que:** `.github/workflows/estado-no-merge.yml`:
  - `on: pull_request: types [closed]` e `workflow_dispatch` com input `pr` (obrigatório, número).
  - `if` do job: `vars.ESTADO_NO_MERGE` em `simular`/`on` E (dispatch OU (`merged` e base `main` e
    `head.repo.full_name == github.repository`)).
  - `permissions: contents: read, pull-requests: read`; `concurrency` por PR, sem cancelar.
  - Checkout esparso só de `/.github/` da `main`, `persist-credentials: false`; `setup-node` 24;
    actions pinadas pelo mesmo SHA dos outros workflows.
  - Um passo roda a CLI com `LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}`, `GITHUB_TOKEN`,
    `ESTADO_NO_MERGE: ${{ vars.ESTADO_NO_MERGE }}` e `--pr ${{ inputs.pr }}` no dispatch.
- [ ] **Teste que falha antes:** `.github/scripts/estado-no-merge-workflow.test.mjs` lê o YAML como texto
  e confere: gatilhos; `if` com a variável e com `merged`; nenhum checkout de `head.sha`/`head.ref`;
  `persist-credentials: false`; nenhuma permissão `write`; secret só no `env` do passo da CLI.
- [ ] **Arquivos:** workflow e teste. Escopo S.

## Ponto de controle: depois de T3

- [ ] `node --test .github/scripts/*.test.mjs` verde nos três modos
- [ ] `node .github/scripts/estado-no-merge.mjs` com `ESTADO_NO_MERGE=simular` e o evento de exemplo,
  com rede falsa, imprime a decisão (saída vai para a Evidência)

## T4: registro de flags e /pri-pr (AC-02)

Depende de T3 (o arquivo do workflow precisa existir para o registro).

- [ ] **O que:**
  - `docs/flags.md`: linha `ESTADO_NO_MERGE`, `Onde` = `.github/workflows/estado-no-merge.yml`,
    Padrão `desligada`, Issue `PRI-399`, Consumidor `não se aplica: CI deste repo`, Ligar quando
    "o Richard grava `simular`, confere o resumo do job num merge e grava `on`", Desligar quando
    "move issue errada ou reescreve Estado fora do bloco", Decidir até `2026-12-18`, Item desligado
    `sim`; "Hoje são 10" vira 11.
  - `.claude/skills/pri-pr/SKILL.md`, passo 7: uma frase dizendo que, com `ESTADO_NO_MERGE=on`, a
    Action move Leve e Médio para Done no merge; o `/pri-pr` continua sem mover.
- [ ] **Teste que falha antes:** `node scripts/lib/flag-registry.test.js` com a linha nova (antes de
  existir o workflow, `SOURCE_MISSING`); depois, verde. Conferir que nenhum teste depende da
  contagem 10.
- [ ] **Arquivos:** `docs/flags.md`, `.claude/skills/pri-pr/SKILL.md`. Escopo XS.

## Ponto de controle: fim

- [ ] `npm test` e `npm run check` verdes na raiz (`/pri-check`)
- [ ] Evidência: testes por AC e saída do `--simular`; o `/pri-pr` marca a F0.9 `concluída`
