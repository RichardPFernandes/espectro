# Spec: verificação de UI em navegador real no fluxo do Espectro

> **Status:** APROVADA pelo Richard em 14/11/2026; **reclassificada para Alto** no mesmo dia. Duas rodadas de
> revisão (código, segurança, testes) feitas em 14/11; os achados da 2ª foram corrigidos e viraram testes de
> regressão (sem 3ª rodada: decisão do Richard). Issue: PRI-355, rótulo `Processo: Alto`. Fica em `tasks/ui-verify/`
> porque o `SPEC.md` da raiz era da PRI-205 S3b (hoje em `docs/historico/SPEC-pri-205-s3b.md`).
> **AUTORIZO:** este PR só adiciona código atrás da flag `PRISMA_UI_VERIFY=off`. Ligar a flag em qualquer
> consumidor precisa de AUTORIZO próprio do Richard (nada é ligado aqui).

## Objetivo

Hoje o fluxo `fetch_ticket → plan → implement → review → test → verify → commit` nunca abre a aplicação:
um agente passa em todos os gates com a tela quebrada. O `/verify` ganha o passo 2b: navegador headless,
telas afetadas pelos ACs de UI, veredito PASSOU/FALHOU. Falhou: volta ao `implement`, sem commit.

## Por que Alto

O navegador é pré-aprovável, lê conteúdo de terceiros (texto de ticket e log renderizados no dashboard) e
fica ao alcance das ações do dashboard (aprovar autorização, iniciar run, escrever no Redmine). A revisão
G3 mostrou que isso encosta em operação protegida e credencial (regra 7). Por isso o desenho abaixo
isola o navegador em vez de confiar no agente.

## Decisões de desenho

1. **Sem nó novo no grafo.** Passo 2b do `/verify`; a falha usa `verify → implement --retry`.
2. **Playwright MCP `0.0.85` fixado e vendorizado** em `tools/playwright-mcp/` com lockfile, `npm ci --ignore-scripts` (PRI-360) (Chrome instalado, `--isolated`, headless). `chrome-devtools-mcp` fora:
   console e rede já vêm no Playwright; trace de performance ninguém pediu.
3. **Servidor próprio, fixture, somente leitura.** `server ensure` sobe o dashboard com `REPO_PATH` = diretório
   temporário com só os assets de contrato (sem `.env`, credencial ou run do consumidor), HOME/TMPDIR
   sintéticos, loopback e `PRISMA_DASHBOARD_READONLY=1` (toda escrita → 403, mesmo same-origin).
   Somente leitura por allowlist de método (GET/HEAD/OPTIONS); GETs com efeito colateral (`claude -p`, `git fetch`,
   consulta externa) viram respostas neutras. Servidor de terceiros na porta é **recusado** (`PORT_IN_USE`); o
   reaproveitamento do próprio servidor confere PID, grupo, horário de início e código. Servidor customizado
   exige `PRISMA_UI_CUSTOM_SERVER=1` (nível Alto, AUTORIZO próprio).
4. **Pré-aprovação só local.** `enabledMcpjsonServers` e a lista de ferramentas ficam em
   `.claude/settings.local.json` (fora do git; modelo em `.example`). Versionado: só `permissions.deny` de
   `browser_evaluate`, `run_code_unsafe`, `file_upload`, `drop`, rotas, cookies e storage.
   A porta do `.mcp.json` é validada (só dígitos) dentro do script, não por expansão no texto.
5. **Hook `playwright-fs-guard`** (versionado, fail-closed): `filename` só em `.prisma/ui-verify/<task-id>/` (symlink
   resolvido), `url` só da porta da verificação, sem `paths`. O estado do CLI mora em `.prisma/ui-state/`, fora da
   área que o navegador escreve.
6. **Veredito fail-closed:** só PASSOU com todos os checks, todos os ACs de UI cobertos, PNG real e posterior ao
   último `server ensure`; erro, dado ausente, vazio ou fora de formato reprova. `touches` e `verdict`
   distinguem erro (exit 2, UNKNOWN) de "sem frontend" (exit 1); base do git é validada; globs fora da plataforma
   são obrigatórios. O veredito continua sendo atestação do agente (limite documentado).
7. **Flag `PRISMA_UI_VERIFY=on|off`**, padrão `off` (`SKIPPED`); outro valor é erro.

## Comandos

```
Manual:      /verify-ui <task-id>                     # PRISMA_UI_VERIFY=on na sessão
Janela:      PRISMA_UI_HEADLESS=false                 # antes de abrir a sessão
Servidor:    node scripts/ui-verify.js server ensure | stop
Frontend?:   node scripts/ui-verify.js touches <base>
Veredito:    node scripts/ui-verify.js verdict <findings.json> --base <base> --acs AC-1,AC-2|none
Testes:      node --test scripts/lib/ui-verify-verdict.test.js scripts/lib/ui-verify-cli.test.js \
                         .claude/hooks/playwright-fs-guard.test.mjs   # + npm test em scripts/ e dashboard/
Mutação:     40/43 mutantes mortos; os 3 vivos são equivalentes (defesa em profundidade redundante)
```

## Estrutura

```
.mcp.json                                  Playwright MCP fixado (porta via PRISMA_UI_PORT, padrão 3399)
.claude/settings.json                      + hook playwright-fs-guard (sem allow, sem enable)
.claude/settings.local.json.example        modelo do que cada pessoa aprova localmente
.claude/hooks/playwright-fs-guard.mjs      guarda de filename (+ teste)
.claude/commands/verify-ui.md              comando fino
.claude/commands/verify.md                 + passo 2b
.agents/skills/prisma-ui-verify/SKILL.md   procedimento e regras de segurança
scripts/ui-verify.js, scripts/lib/ui-verify-verdict.js   CLI e regras (+ testes)
dashboard/server.js                        + PRISMA_DASHBOARD_READONLY (+ teste)
docs/ui-verify.md                          como rodar à mão e modelo de segurança
```

## Testes

- Veredito (unit): cada código de problema, cada falso PASSOU reproduzido na revisão, globs, configs.
- CLI (integração, repositório git e servidores falsos em porta efêmera): `touches` (acento, rename, erro),
  `verdict` (arquivo, flag, verdict.json velho), ciclo de vida (reuso, concorrência, timeout, erro de spawn,
  estado adulterado, PID reaproveitado, porta de terceiros, sem sobra de processo/porta/tmp).
- Dashboard: escrita recusada com a flag, leitura segue.
- Demonstração real: PASSOU numa tela do dashboard e FALHOU com elemento inexistente.

## Limites

- **Sempre:** headless; servidor próprio somente leitura; versão do MCP fixada; fail-closed; flag `off`.
- **Perguntar antes:** ligar `PRISMA_UI_VERIFY` num consumidor (AUTORIZO); mexer em `graph.yaml`/schema;
  incluir os testes novos no `processo-check.yml`; liberar outra ferramenta do MCP.
- **Nunca:** credencial no repo; instalar algo global; reaproveitar servidor de terceiros; `browser_evaluate`;
  anexar screenshot ao PR/Linear; reescrever passos existentes do `/verify`; merge (é do Richard).

## Critérios de sucesso

- AC-1 `.mcp.json` válido, Playwright fixado, headless, origem restrita à porta de verificação.
- AC-2 `/verify-ui` sobe o dashboard, navega, gera screenshot e dá PASSOU numa tela real.
- AC-3 Elemento inexistente forçado dá FALHOU com AC, código e print.
- AC-4 A porta fica livre depois do stop, inclusive em falha; nenhum processo, porta ou tmp órfão.
- AC-5 Com `PRISMA_UI_VERIFY=off`, o `/verify` se comporta como hoje (diff do `verify.md` só aditivo).
- AC-6 `docs/ui-verify.md` ensina a rodar à mão e com janela visível.
- AC-7 O dashboard da etapa recusa toda escrita e não carrega `.env` do consumidor.

## Riscos e rollback

| Risco | Mitigação |
| --- | --- |
| Falso PASSOU no gate | Veredito fail-closed + testes de cada formato inválido |
| Texto injetado dirige o navegador | Somente leitura no servidor, ferramentas mínimas, hook de filename, regra na skill |
| Supply chain do MCP (`npx -y`, alpha do Playwright de 09/11) | Versão exata + lockfile + `--ignore-scripts` (PRI-360); sem `npx` |
| Veredito forjado por agente injetado | Limite documentado (atestação do agente); humano revisa; hook e deny reduzem o que o agente alcança |
| Código do branch roda como o usuário em `npm start` | Inerente ao `/verify`; sem sandbox de arquivos (documentado) |
| Processo ou diretório órfão | PID/grupo/início conferidos, lock, limpeza só do que criou |

**Rollback:** `PRISMA_UI_VERIFY=off` (menos de 1 min); `git revert` remove tudo (nada fora do repo é alterado).
**Dependências:** `@playwright/mcp@0.0.85` vendorizado em `tools/playwright-mcp/` (lockfile; instalar uma vez por checkout); Chrome instalado.

## Decisões tomadas (14/11/2026)

Validação só no dashboard; Chrome instalado; MCP fixado; **nível Alto**; pré-aprovação só em
`settings.local.json`; fixture própria e nunca reaproveitar servidor de terceiros.

## Em aberto (não bloqueia este PR)

1. Vendorizar o MCP com `package-lock.json` e `--ignore-scripts` (M-2 da revisão); hoje só a versão está fixa.
   A revisão sugeriu também testar `--ignore-roots` com `cwd` em `.prisma/ui-verify` (confinamento nativo do MCP):
   não validado aqui.
2. Incluir `playwright-fs-guard.test.mjs` e os testes novos no `processo-check.yml` (mexe em CI: pergunta).
3. UI do consumidor (app-front): configuração dele, fora desta fatia.
