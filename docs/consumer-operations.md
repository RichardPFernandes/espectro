# Consumo, diagnóstico, cutover e retorno

Procedimento do recorte entregue na PRI-63, documentado pela PRI-64 em 2026-10-08.
O app-back consome a revisão Prisma `a50ff9fec1b44382eb6c97940b31a5bb42632a40`,
tree `97fe983cdbb51c91e639c8266819398800d67a64`, em `../prisma-wt/pri-63`.
A main posterior não substitui esse pin. O [handoff](extraction-handoff.md)
identifica provas e limites; este texto não executa uma troca.

## Preparação e configuração

Dois pacotes Node separados, `scripts/` e `dashboard/`, com locks próprios. O
ambiente da extração foi Node 20.20.2/npm 10.8.2; isso é ambiente observado, não
matriz universal. Para preparar dependências em checkout isolado, usar `npm ci
--ignore-scripts --no-audit --no-fund` em cada pacote, após conferir manifests/locks.
Não instalar ou substituir dependências na candidata ativa por este documento.

Código/assets pertencem a PRISMA_ROOT; REPO_PATH, .env, memory, worktrees, archive,
prefs e histórico pertencem ao consumidor. O launcher do app-back fixa os roots
absolutos, a revisão e os hashes dos dois arquivos admitidos:

| Arquivo no app-back | SHA-256 |
| --- | --- |
| prisma-consumer.env | 767066520961af1bf36476ba52e217826d884220b4f82b61e95a575f0f69fa29 |
| config/consolidator-module-keywords.json | 423d01e6f829466671b32dfc6d43a4df6787b51cde4fed6782954f196e90876c |

O exemplo app-back/scripts/prisma-consumer.env.example é histórico/inativo; não substitui
esses arquivos. Segredos permanecem no .env do app-back e nunca entram no Prisma.
O launcher remove o override herdado BITBUCKET_API_TOKEN para reler o .env atual.

| Seam | Responsabilidade do consumidor |
| --- | --- |
| WATCHER_MAIN_REPO_NAME / WATCHER_SIBLING_REPOS | Nome e slugs explícitos dos repos |
| PRE_BUILD_COMMAND / TEST_COMMAND / TEST_SCOPED_COMMAND | Toolchain e comandos de build/teste |
| CONSOLIDATOR_MODULE_KEYWORDS_FILE | Taxonomia no consumidor |
| SPEC_RULE_PACKAGE_PREFIX / OPENAPI_RESPONSE_FACTORY_FILE | Heurísticas específicas do app-back |
| PREVIEW_ADAPTER | Adapter existente maven-quarkus-grunt, quando admitido |

Não criar Configuration Service, registry ou engine adicional para esses seams.

## Uso no consumidor após admissão

Antes de qualquer início vivo, conferir e remover DRY_RUN=true herdado; o launcher
só recusa essa variável no modo watcher. Conferir modo e logs após o início, sem
interpretar simulação como consumo vivo.

No app-back/dashboard, `npm start` chama `bash ../scripts/prisma-start.sh dashboard`.
O servidor atende `127.0.0.1:3333`. O launcher exige prefs efetivas com
`auto_start: false`; Start no painel é uma operação humana global, sem filtro.
Em 08/10, o loop global foi restaurado explicitamente, e o primeiro tick terminou
idle sem erro; isso é observação histórica, não consulta de disponibilidade atual.

Para um tick vivo avulso, após verificar autoridade, sujeito e ausência de writer:

```bash
# cwd: app-back; substituir 12345 pelo ticket positivo admitido
bash scripts/prisma-start.sh watcher --ticket=12345
```

O launcher recusa DRY_RUN=true no modo watcher e opções adicionais; não usa --follow.
`--ticket` não significa somente leitura. Startup, polling, logs, metadata, AC/KG,
cleanup e notificações têm efeitos próprios. DISABLE_AUTO_CLEANUP=true desliga
rotação, não todas as formas de cleanup. Para planejamento somente leitura, o
watcher oferece `--dry-run`, distinto da simulação DRY_RUN=true; simulação exige
fixture sintética admitida e ambiente isolado, sem estado/credenciais vivos.

## Diagnóstico antes de alterar execução

1. Conferir HEAD e tracked drift da candidata, sem atualizar para latest.
2. Conferir hashes da config, roots absolutos e prefs efetivas no consumidor.
3. Consultar a trava comum: `node "$PRISMA_ROOT/scripts/lib/watcher-lock.js" status --repo="$REPO_PATH"`.
   Exit 0 significa nenhum watcher/agente destacado vivo; exit 1 indica presença.
   A trava é local ao host, não exclusividade entre hosts.
4. Identificar o processo servido e a porta; conferir GET /api/runs e
   /api/watcher/status, modo, erros e logs saneados. Exit 0 sozinho não prova sucesso.
5. Em 401/403, drift, sujeito inesperado, efeito incerto ou estado ilegível, parar a
   operação dependente e levar o resultado ao Richard. Não repetir POST/commit cegamente.

## Nova janela de cutover

Uma nova revisão exige revalidação do delta: mesma candidata/config nas provas de
integração e retorno, autorização da janela, inventário dos runs em voo, drenagem
pela fonte e preservação das identidades/bindings. Não retomar run anterior em
engine novo por inferência. Parar o loop via painel, esperar agentes/lease/trava,
identificar e SIGTERM no dashboard anterior, conferir porta liberada e excluir
DRY_RUN=true herdado. Subir a
revisão fixada, confirmar PID/command/roots/API, observar ticks e deltas por hash.
Start global é decisão separada do tick filtrado. Registrar APPLIED/REVERTED ou
pendência com provas; build verde não é cutover. DOM06 não foi provado na janela
histórica, conforme waiver delimitado, e permanece UNKNOWN para essa revisão.

## Retorno autorizado à fonte

O snapshot selecionado de 236 arquivos (sha256
`1191361d93f1a3dbe609a45bd881c0c8633bf8e491b99b5036b7d251aeda5731`)
permanece no run PRI-62 do app-back. Não é backup de todo checkout ou estado.
O dashboard/package.json atual tem delta declarado: start seleciona Prisma;
start:source conserva node server.js. Não exigir igualdade silenciosa desse arquivo
com o snapshot antigo nem restaurá-lo em massa.

1. Registrar decisão humana e o escopo. Parar o loop da candidata, esperar agentes
   e leases, conferir trava, encerrar o dashboard identificado com SIGTERM.
2. Conservar o checkout da candidata enquanto wrappers/agentes ainda o referenciem.
3. Comparar fonte/config com o snapshot e deltas admitidos. Drift inesperado exige
   decisão arquivo a arquivo; sem reset/clean/restore global.
4. Usar shell limpa, sem os exports de prisma-consumer.env, PRISMA_ROOT ou overrides
   do launcher (REPO_PATH, MEMORY_DIR, WORKTREES_DIR, RUNS_ARCHIVE_DIR,
   DISABLE_AUTO_CLEANUP, HOST, PORT, DRY_RUN), e sem override BITBUCKET_API_TOKEN. A configuração
   da fonte continua no .env atual do consumidor; não restaurar credencial anterior.
5. Em app-back/dashboard, executar `npm run start:source` com cwd correto. Não usar
   npm start para retornar: esse comando agora seleciona Prisma. O watcher da fonte
   é app-back/scripts/readmine-watcher.js, sob operação explicitamente admitida.
6. Conferir processo/roots/API, ausência de disputa de writer e os dois primeiros
   ticks admitidos. Runs interrompidos, gates humanos e efeitos incertos continuam
   exigindo decisão; não repetir nó concluído, criar PR duplicado ou mudar execution_id.
7. Registrar retorno e pós-condições, ou suspender a operação dependente em caso de
   falha. Não restaurar states, Context Records, snapshots lógicos, refs ou histórico.

A [prova histórica de retorno](rollback.md) descreve C0–C5 em fbb597c; a
revalidação na revisão a50ff9f está no handoff PRI-63. Nenhum desses ensaios
certifica revogação universal, DOM06 ou disponibilidade de produção TMS.
