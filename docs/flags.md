# Registro de flags

Lista única das flags do Prisma: variável de ambiente ou chave de arquivo que liga, desliga
ou escolhe um comportamento. Caminho, porta, limite, URL e credencial são configuração e
ficam só no [`.env.example`](../.env.example). Fatia F1.1 (PRI-377).

O teste `scripts/lib/flag-registry.test.js` roda no CI e falha quando:

- o código lê, com forma de flag (`/^(1|true|sim)$/`, `=== 'on'`, `!== '0'`, `|| 'off'`, `['on', 'off'].includes(...)`, ou alias comparado depois), uma variável que não está na tabela;
- uma linha está incompleta, duplicada, com valor fora do vocabulário, ou sem data de decisão;
- a data de decisão venceu;
- uma flag de ambiente da tabela não é mais lida pelo código, ou o arquivo de uma flag de arquivo sumiu.

## Como ler

- **Padrão:** estado do recurso quando a variável está ausente. `DISABLE_AUTO_CLEANUP` é "ligada" porque, sem a variável, a limpeza roda.
- **Consumidor:** estado no consumidor corporativo. O `.env` dele não é lido aqui (dado do consumidor não acompanha o código), então vale `não verificado`, que não é "desligada". Só entra valor quando um documento do repo o afirma.
- **Decidir até:** data (AAAA-MM-DD, em UTC) em que a flag liga de vez, é removida ou é renovada por decisão do Richard. Para flag permanente, é a próxima reconfirmação (seis meses). Passou da data sem decisão, o CI fica vermelho.
- **Item desligado:** `sim` para o que foi construído e está desligado (métrica "itens construídos e desligados" do [`ACOMPANHAMENTO.md`](../roadmap/ACOMPANHAMENTO.md)). Hoje são 10. O roadmap não lista quais; esta lista foi reconstruída do código e dos documentos do roadmap, e quem discordar corrige a coluna.

## Limites da detecção

A detecção usa o scanner da regra `env-documented` (`scripts/lib/config-validator.js`) e o
reconhecimento de booleano acima. Ela não vê:

- seletor de valor, como `PREVIEW_ADAPTER`, que entra só à mão;
- desestruturação (`const { X } = process.env`), `env?.X` e nome de variável montado em tempo de execução;
- arquivos fora de `scripts/`, `scripts/lib/` e `dashboard/` (hooks em `.claude/hooks/`, `.github/scripts/`, `harness/`) e subpastas.

Flag nova nessas formas precisa da linha à mão; o teste só garante que a linha, uma vez
escrita, aponte para algo que o código ainda lê.

## Como mudar

Flag nova: adicione a linha com a data de decisão no mesmo PR que a introduz, e a variável ao
`.env.example`. Ligar, remover ou renovar uma flag no consumidor continua exigindo o AUTORIZO
do Acordo; este registro só diz quando a decisão é devida.

## Tabela

| Flag | Onde | Padrão | Issue | Consumidor | Ligar quando | Desligar ou remover quando | Decidir até | Item desligado |
| -- | -- | -- | -- | -- | -- | -- | -- | -- |
| `WATCHER_PHASE_EFFORT` | env | desligada | PRI-353, PRI-354 | não verificado | o piloto da PRI-354 mostra custo e tempo melhores (teto: 10 pares de runs ou 3 semanas) | o piloto não mostra ganho, ou o esforço padrão da conta é menor que `high` (ligar gastaria mais) | 2026-12-07 | sim |
| `WATCHER_PLAN_IMPLEMENT_CHAIN` | env | desligada | PRI-353, PRI-354 | não verificado | o piloto decide; só vale com pré-build pulado e roteamento OFF | o piloto não mostra ganho, ou segue inelegível no repo do Espectro (roteamento ON) | 2027-01-15 | sim |
| `WATCHER_PLAN_DENY_SETTINGS` | env | desligada | PRI-315 | não verificado | nova medição, por decisão do Richard (a medida da PRI-315 não mostrou ganho) | remover na F2.5 | 2027-01-15 | sim |
| `WATCHER_QA_DIAGNOSTICO` | env | desligada | PRI-181 | não verificado | passa o Promotion Gate próprio e o modelo deixa de recusar a chave que a identidade gera | congelada (F6.10); remover se o dado não justificar | 2027-01-15 | sim |
| `WATCHER_CLI_RESULT_JSON` | env | desligada | PRI-381 | não verificado | o PR da F1.5 é mesclado e o piloto no Espectro mostra, no weekly, "Fonte do custo" com runs no JSON da CLI e a diferença CLI − transcript explicada; aceitar o log mudo (com `--output-format json` a CLI só imprime no fim, então o log do ticket e o agent-log do dashboard não mostram progresso durante o nó); ligar no consumidor é Alto, com AUTORIZO próprio | o JSON da CLI não chega ao log (runs voltam a cair no transcript), diverge sem explicação do transcript, ou o log mudo atrapalha acompanhar ou diagnosticar um run | 2027-01-15 | sim |
| `PRISMA_UI_VERIFY` | env | desligada | PRI-355, PRI-360, PRI-361 | não verificado | PRI-360 e PRI-361 terminam e há dado que justifique (F6.8) | congelada (D5); remover se não houver dado | 2027-01-15 | sim |
| `PRISMA_UI_VERIFY_TAB` | env | desligada | PRI-355, PRI-361 | não verificado | junto de `PRISMA_UI_VERIFY` | junto de `PRISMA_UI_VERIFY` | 2027-01-15 | não |
| `PRISMA_UI_CUSTOM_SERVER` | env | desligada | PRI-355 | não verificado | junto de `PRISMA_UI_VERIFY`, só se o app não sobe pelo dashboard | junto de `PRISMA_UI_VERIFY` | 2027-01-15 | não |
| `PRISMA_OBSIDIAN` | env | desligada | PRI-373 | não verificado | a PRI-373 é mesclada e o uso se confirma (docs/obsidian.md) | a PRI-373 sai na triagem do cycle | 2026-12-07 | sim |
| `PRISMA_DASHBOARD_READONLY` | env | desligada | sem issue | não verificado | `=1` bloqueia as rotas de escrita do dashboard | nunca precisa remover; é salvaguarda | 2027-05-17 | não |
| `DRY_RUN` | env | desligada | sem issue | não verificado (só vale no processo da simulação) | rodar o watcher ou o dashboard em simulação; `DRY_RUN_FIXTURE`, `DRY_RUN_DELAY_FACTOR` e `DRY_RUN_RISK_LEVEL` são parâmetros dela e só valem sob `DRY_RUN` | nunca precisa remover; é o modo de ensaio | 2027-05-17 | não |
| `DISABLE_AUTO_CLEANUP` | env | ligada | sem issue | o launcher pinado exporta; o sem pin não (docs/consumer-operations.md) | a limpeza automática de runs já roda por padrão | sandbox ou teste que não pode arquivar runs: `1`, `true` ou `sim` desliga a limpeza | 2027-05-17 | não |
| `SKIP_PRE_BUILD_VALIDATION` | env | ligada | sem issue | não verificado | a validação de build antes do implement já roda por padrão | emergência, ou o encadeamento plan+implement, que exige pular o pré-build: só o valor `true` pula | 2027-05-17 | não |
| `SPEC_AUTO_REPAIR` | env | ligada | sem issue | não verificado | o reparo automático de spec já roda por padrão | `=0` volta ao pedido de aceite puro, se o reparo atrapalhar | 2027-05-17 | não |
| `SPEC_DRAFT_AUTOGEN` | env | ligada | sem issue | não verificado | a geração do rascunho de spec já roda por padrão | `=0` desliga a geração; o bloqueio de spec com `draft: true` continua | 2027-05-17 | não |
| `WATCHER_RECUSA_QA_NOVO_CICLO` | env | desligada | sem issue | não verificado | só para voltar ao comportamento antigo (recusa de QA abre ciclo novo sozinha) | ninguém mais precisa do comportamento antigo | 2027-05-17 | não |
| `TRANSCRIPTS_DISABLED` | env | ligada | sem issue | não verificado | a gravação de transcrições já roda por padrão | `=true` quando disco ou privacidade pedirem | 2027-05-17 | não |
| `WORKTREE_CLEANUP_ON_PR_OPEN` | env | ligada | sem issue | não verificado | a limpeza ao abrir o PR já roda por padrão | `=0` volta a limpar só depois do merge | 2027-05-17 | não |
| `PREVIEW_ADAPTER` | env | desligada | sem issue | não verificado | o adapter `maven-quarkus-grunt` é admitido no consumidor (docs/consumer-operations.md) | o consumidor deixa de usar preview | 2027-05-17 | não |
| `PREVIEW_GRUNT_FORCE` | env | ligada | sem issue | não verificado | o grunt seguir apesar de warning do htmlhint já vale por padrão | `=false` volta ao comportamento do `grunt serve` do repo | 2027-05-17 | não |
| `PREVIEW_GRUNT_WATCH` | env | desligada | sem issue | não verificado | `=true` quando o preview precisar do watch | o preview não precisa mais do watch | 2027-05-17 | não |
| `PREVIEW_MVN_OFFLINE` | env | desligada | sem issue | não verificado | `=true` roda o Maven do preview em modo offline | o preview volta a buscar dependência online | 2027-05-17 | não |
| `PREVIEW_LIBS_FROM_BRANCH` | env | ligada | sem issue | não verificado | a lib da branch já vale por padrão | `=false` quando a lib velha precisar sobrescrever | 2027-05-17 | não |
| decomposição | `.claude/model-routing.json#decomposition` | desligada | PRI-341, PRI-310 | desligada por padrão no código; arquivo do consumidor não verificado | o piloto da PRI-341 (F2.2) fecha com n suficiente, depois da PRI-335 | o piloto reprova | 2027-01-15 | sim |
| roteamento | `.claude/model-routing.json#mode` | desligada | PRI-233 | `mode: "OFF"` no `app-back/.claude/model-routing.json` (docs/consumer-operations.md, linha "Roteamento no app-back"); neste repo o arquivo está em `mode: "ON"` (piloto no Espectro) | AUTORIZO próprio para ligar no consumidor | o piloto de roteamento reprova | 2027-05-17 | não |
| classificador Jev | `scripts/lib/classifier-selection.js` | desligada | PRI-205, PRI-321, PRI-291 | não verificado (a escolha mora em registro do consumidor, fora do git) | há dado que justifique e a calibração passa (F6.8) | congelado (D5); remover se não houver dado | 2027-01-15 | sim |
| writer de Self-SDD | `scripts/lib/sdd-writer.js` | desligada | PRI-349 | não roda: sem chamador fora dos testes (roadmap/BASE.md, fato 16) | a PRI-349 e filhas dão a ele um chamador (D5) | só por decisão do Richard (D5) | 2027-01-15 | sim |
