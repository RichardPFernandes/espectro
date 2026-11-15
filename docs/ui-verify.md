# Verificação de UI em navegador real

Etapa opcional do `/verify` (passo 2b) que abre a aplicação num navegador headless e confere as
telas afetadas pelos ACs. **Desligada por padrão** (`PRISMA_UI_VERIFY=off`). Issues: PRI-355 (nível Alto) e PRI-360 (MCP vendorizado, nível Médio).

## Como encaixa no fluxo

```text
… → implement → review → test → verify ──(2b, só se toca frontend)──▶ commit
                  ▲                          │ FALHOU: sem commit
                  └──────────────────────────┘ volta ao implement com a lista de problemas
```

Não há nó novo no grafo: a falha usa a aresta que já existe (`verify → implement --retry`, limite
`retries.verify`). `SKIPPED` = flag `off` (comportamento de hoje). `N/A` = diff sem frontend ou spec
sem AC de UI. Falta de dado, erro de `touches` (exit 2) ou MCP ausente é UNKNOWN, nunca PASSOU.

## Peças

| Peça | Papel |
| --- | --- |
| `.mcp.json` | Chama o binário local `tools/playwright-mcp/node_modules/.bin/playwright-mcp` (sem `npx`; ausente = exit 2), Chrome instalado, perfil em memória, origem só `localhost`/`127.0.0.1` na `PRISMA_UI_PORT` (validada: só dígitos) |
| `tools/playwright-mcp/` | `package.json` com `@playwright/mcp` em versão exata (`0.0.85`) e `package-lock.json` versionado; instalado com `npm ci --ignore-scripts` |
| `.claude/settings.local.json` (local, **fora do git**; modelo em `.claude/settings.local.json.example`) | Aprova o servidor `playwright` e lista as ferramentas liberadas |
| `.claude/settings.json` (versionado) | `permissions.deny` de `evaluate`, `run_code_unsafe`, `file_upload`, `drop`, rotas, cookies e storage, e o hook abaixo |
| `.claude/hooks/playwright-fs-guard.mjs` | Fail-closed: `filename` só em `.prisma/ui-verify/<task-id>/` (symlink resolvido), `url` só da porta da verificação, sem `paths` |
| `.agents/skills/prisma-ui-verify/SKILL.md` | Procedimento e regras de segurança do agente |
| `.claude/commands/verify-ui.md` | Comando fino; o `/verify` o chama |
| `scripts/ui-verify.js` | Servidor (ensure/stop), `touches`, `verdict` |
| `scripts/lib/ui-verify-verdict.js` | Regras do veredito (fail-closed, testadas) |
| `dashboard/server.js` (`PRISMA_DASHBOARD_READONLY=1`) | Recusa toda escrita, mesmo same-origin |
| `.prisma/ui-verify/<task-id>/` | Screenshots, `findings.json`, `verdict.json` (ignorado pelo git; **única** área que o navegador escreve) |
| `.prisma/ui-state/` | Estado do CLI (`server.json`, `session.json`, `server.lock`, `server.log`); o hook nega escrita do navegador aqui |

O `chrome-devtools-mcp` ficou de fora: o Playwright MCP já entrega console e rede. Reavaliar se
surgir AC de performance (trace).

## Habilitar na sua máquina (uma vez por checkout)

O MCP **não** vem pré-aprovado no repositório: o `settings.local.json` vale para sessões abertas neste checkout
(worktrees não o herdam). Para usar:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json   # arquivo ignorado pelo git
```

Instale o MCP **uma vez por checkout** (e de novo ao trocar a versão no lockfile):

```bash
(cd tools/playwright-mcp && npm ci --ignore-scripts)   # só o que o lockfile fixa; nenhum script de instalação roda
(cd dashboard && npm ci)                                # dependências do dashboard de fixture
```

Depois abra a sessão do Claude Code neste checkout. `PRISMA_UI_VERIFY=on` liga a etapa. Sem a instalação, o
`.mcp.json` recusa subir (exit 2 com a instrução acima) e a etapa fica UNKNOWN; ele **nunca** cai em `npx`.
`--ignore-scripts` basta porque o Playwright MCP não baixa navegador: usa o Chrome em `/Applications`
(não baixa Chromium). O teste do lockfile falha se alguma dependência passar a exigir script de instalação.
**Atualizar a versão** é mudança de nível Alto (muda o que roda no consumidor): `npm install --save-exact
--ignore-scripts @playwright/mcp@<versão>` em `tools/playwright-mcp/`, com o lockfile no mesmo PR.

## Rodar à mão

```bash
PRISMA_UI_VERIFY=on        # no ambiente da sessão
/verify-ui <task-id>
```

**Janela visível (debug):** inicie a sessão com `PRISMA_UI_HEADLESS=false`.
**Outra porta:** `PRISMA_UI_PORT=3410` antes de abrir a sessão (o MCP lê a porta ao iniciar).

**Só o servidor / o veredito:**

```bash
S="node $PWD/scripts/ui-verify.js"
$S server ensure          # sobe um dashboard próprio (fixture, somente leitura) e espera HTTP; marca a sessão
$S server stop            # só encerra o que ele subiu (PID, grupo, início e token de posse conferidos)
$S touches <base>         # 0 toca frontend · 1 não toca · 2 erro (UNKNOWN)
PRISMA_UI_VERIFY=on $S verdict .prisma/ui-verify/<task-id>/findings.json --base <base> --acs AC-1,AC-2|none
```

`touches`/`verdict` rodam o git em `REPO_PATH` (padrão: cwd). `<base>` é resolvida para um commit; base que
começa com `-` é recusada. O `ensure` reinicia o servidor se o código mudou, e o `verdict` rejeita findings e
PNGs anteriores ao último `ensure`. Exit 2 é sempre UNKNOWN.

Se a porta já tem um servidor que não é nosso, o `ensure` recusa (`PORT_IN_USE`): ele pode rodar
código de outro checkout e aceitar escrita. Use outra `PRISMA_UI_PORT`.

## Ver o resultado no dashboard (aba "Verificações de UI")

O resultado de cada `/verify-ui` (veredito, problemas e screenshots por AC) aparece na aba **Verificações de UI**,
grupo Operação do menu. É uma leitura de `<plataforma>/.prisma/ui-verify/<task-id>/`: não escreve nada e funciona
também com `PRISMA_DASHBOARD_READONLY=1`.

```bash
PRISMA_UI_VERIFY_TAB=on node dashboard/server.js    # desligada por padrão
```

- Desligada: a aba não entra no menu, `GET /api/ui-verify` responde `200 {"enabled":false,"tasks":[]}` e a rota de
  imagem responde 404. A listagem não pode dar 4xx: a página a consulta a cada carga, e um 404 viraria erro de
  console e requisição `>= 400` em toda tela, reprovando o próprio `/verify-ui` do dashboard.
- Veredito ausente, ilegível ou incoerente (por exemplo `PASSOU` com problemas listados) aparece como **Sem veredito**,
  nunca como "Passou". O mesmo vale quando `findings.json` ou um PNG é mais novo que o `verdict.json`: o
  `/verify-ui` só apaga o veredito ao rodar `verdict`, então uma rodada que caiu antes disso deixaria o veredito
  anterior valendo para achados novos.
- A rota de imagem só serve PNG real e regular da pasta da própria task (até 10 MB): nome por allowlist, pasta da
  task precisa ser diretório real, e o arquivo é aberto com `O_NOFOLLOW` e validado no mesmo descritor, então
  trocar por symlink depois da checagem não muda o que sai.
- Screenshot dos achados só liga à imagem se aponta para a pasta da própria task.
- Pasta de outro checkout: `uiVerifyDir` em `createDashboard` (usado nos testes).
- Publicar o veredito no Redmine é outra issue (PRI-362, nível Alto).

## Configuração (env; nenhum valor secreto no repositório)

| Variável | Padrão |
| --- | --- |
| `PRISMA_UI_VERIFY` | `off` (só `on` ou `off`; outro valor é erro) |
| `PRISMA_UI_HEADLESS` | `true` |
| `PRISMA_UI_PORT` | `3399` |
| `PRISMA_UI_VERIFY_TAB` | desligada (só `on` liga a aba "Verificações de UI" do dashboard, PRI-361) |
| `PRISMA_UI_CUSTOM_SERVER` + `PRISMA_UI_SERVER_CMD` / `PRISMA_UI_SERVER_CWD` | ausentes (`npm start` em `<plataforma>/dashboard`). Servidor customizado exige `PRISMA_UI_CUSTOM_SERVER=1`: contorna fixture e somente leitura, é nível Alto com AUTORIZO próprio. O comando aceita lista JSON (`["node","x js"]`) |
| `PRISMA_UI_FRONTEND_GLOBS` | `dashboard/public/**` só na plataforma; **obrigatório** em `REPO_PATH` de outro repo (só `*`, `**`, `?`; sem `{ } [ ] !`; lista vazia é erro) |
| `REPO_PATH` / `PRISMA_ROOT` | cwd / este checkout (o git roda em `REPO_PATH`; os scripts vêm de `PRISMA_ROOT`) |

Login não é suportado nesta fatia (`browser_type`/`browser_fill_form` não estão liberados).

## Modelo de segurança e limites

- O agente lê conteúdo de página (inclusive texto de ticket e log renderizado). Esse conteúdo é dado,
  nunca instrução. As ferramentas liberadas excluem `browser_evaluate`, `browser_run_code_unsafe`,
  `browser_file_upload`, cookies e storage.
- O servidor da etapa é **próprio**: fixture como `REPO_PATH` (sem `.env`, credenciais ou runs do
  consumidor), HOME/TMPDIR sintéticos, env mínimo, loopback e somente leitura por allowlist de método (só
  GET/HEAD/OPTIONS; o resto → 403). Os GETs com efeito colateral (`/api/claude/usage`, `/api/fx`, `refresh` de
  `/api/version`) viram respostas neutras. Porta ocupada por servidor de terceiros é recusada, nunca reaproveitada.
- Supply chain: a versão e as 3 dependências (`playwright`, `playwright-core`, `playwright-mcp`) vêm do lockfile
  com integridade `sha512`; nada é resolvido ou baixado ao subir o MCP.
- `--ignore-roots` com cwd em `.prisma/ui-verify` (PRI-360, AC-4) **foi validado e descartado**. Funciona como
  confinamento nativo (testado com o binário do lockfile: `../../x.png` e `/private/tmp/x.png` são negados com
  "outside allowed roots"), mas passa a resolver o `filename` contra `.prisma/ui-verify`: a convenção atual
  `.prisma/ui-verify/<task-id>/x.png` viraria `.prisma/ui-verify/.prisma/ui-verify/<task-id>/x.png` e quebraria o
  hook, o SKILL e os caminhos do `findings.json`. Adotar exige mudar essa convenção nas três peças; fica como
  melhoria separada. Hoje o confinamento é o hook `playwright-fs-guard` (raiz do workspace = checkout).
- `--allowed-origins` do Playwright MCP **não é fronteira de segurança** (não cobre redirects);
  é higiene. As fronteiras reais são o servidor somente leitura e o hook de `filename`.
- `server stop` confere PID, grupo de processos, horário de início e um token de posse gravado nos diretórios
  temporários; só apaga o que ele criou e só mantém o registro até o processo morrer de fato. Registro adulterado,
  `ps` indisponível ou PID reaproveitado não encerram nada (e o registro é mantido quando há dúvida).
- Screenshots ficam locais. No PR vai só o veredito em texto.
- O veredito é uma **atestação do agente**: ele escreve o `findings.json`. O script garante dado completo, novo e
  bem formado, não impede mentira deliberada; o humano revisa o veredito. O código do branch sob verificação roda
  como o usuário (sem sandbox de arquivos).
- `.mcp.json`, hook e deny valem juntos e só neste checkout. Um consumidor que copie só o `allow` do exemplo fica
  sem o confinamento de `filename`: copie as três peças.
- A UI do consumidor (app-front) fica como configuração dele; esta etapa não a liga.
- Ligar `PRISMA_UI_VERIFY` num consumidor é mudança de nível Alto (AUTORIZO próprio).
