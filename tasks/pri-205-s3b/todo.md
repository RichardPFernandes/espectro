# Tarefas: PRI-205 S3b (núcleo 2 do Jev em sombra)

> Fonte: [SPEC.md](../../SPEC.md) (aprovado em 2026-11-06) e [plan.md](plan.md)
> (proposta). Cada tarefa segue TDD: o teste nasce falhando. Comando focado:
> `node --require ./harness/loopback-only.cjs --test scripts/lib/<arquivo>.test.js`.
> Nenhum teste usa rede externa, o Keychain real ou texto real de ticket.

## T1: zona cinzenta e sonda C1–C3

**Descrição:** função pura `eligibility(signals, planClass)` (chama o núcleo 1 por dentro) que devolve
`{call: bool, probe: GRAY|UPGRADE_PROBE|null, reason}`, conforme as exclusões, G1,
G2 e G3 do B3, e `prioritize(groups, max = 3)`, que põe G1/G2 antes de G3.

**Aceite:**
- [x] Tabela de pelo menos 12 casos (AC-03), incluindo os do §4.5, e os de G3 (AC-03b)
- [x] Cada exclusão soberana tem um caso que não chama: sensível true/UNKNOWN, R1, R2, schema, behavior, config, serviços ≥ 2, rework, Plan acima
- [x] `prioritize` corta em 3 e marca o resto `SKIPPED_BUDGET`

**Verificação:** `node --test scripts/lib/classifier-gray-zone.test.js`
**Dependências:** nenhuma
**Arquivos:** `scripts/lib/classifier-gray-zone.js`, `.test.js`
**Tamanho:** S

**Feito (2026-11-06):** `classifier-gray-zone.test.js` 28/28 em Node 22.23.2 e 24.22.1 (24 casos de tabela + 4); `model-routing` e `routing-config` seguem verdes (97/97 no conjunto); `lint:src`, `check:js` e `arch:check` limpos (o aviso de TypeScript 7 do dependency-cruiser já existia).

## T2: verificador de conteúdo (R-7)

**Descrição:** `checkEnvelope(envelope)` devolve `{ok}` ou `{ok: false,
categories: [...]}` para as categorias do B5. Não devolve o trecho encontrado e
não altera o envelope.

**Aceite:**
- [x] Um caso positivo e um negativo por categoria (AC-05); CPF/CNPJ com dígito verificador e cartão com Luhn
- [x] Os caminhos declarados também passam pelo verificador
- [x] O resultado nunca contém o trecho encontrado

**Verificação:** `node --test scripts/lib/classifier-guard.test.js`
**Dependências:** nenhuma
**Arquivos:** `scripts/lib/classifier-guard.js`, `.test.js`
**Tamanho:** S

**Feito (2026-11-06):** `classifier-guard.test.js` 33/33 em Node 22.23.2 e 24.22.1: 20 casos positivos (11 categorias), 8 negativos (caminhos, versão, hora, data, loopback, CPF com dígito errado, sequência que falha no Luhn, palavra "password" sem valor), mais os testes de campo, de não vazamento, de imutabilidade, fail-closed e `GUARD_VERSION`. `lint:src`, `check:js` e `arch:check` limpos. Valores de teste sintéticos, montados em tempo de execução. Falso positivo conhecido e aceito: hash hex de 32 ou mais caracteres conta como `secret_token`.

## T3: cliente do Jev

**Descrição:** `classify({envelope, classifier, credential, fetchImpl, baseUrl,
timeoutMs})` monta a pergunta versionada (classes C1–C5 e `noul` de risco), envia
com `Authorization: Bearer` e devolve `{outcome: OK|FAILED|UNCERTAIN|NOT_SENT,
certain, http_status, class, confidence, risky, model_reported, latency_ms, parse}`.
Exporta `PROMPT` e `promptSha256`. Faz parte da tarefa um fake HTTP de teste em
127.0.0.1 com roteiro de respostas.

**Aceite:**
- [x] O corpo recebido pelo fake tem só os três campos do envelope (AC-04)
- [x] Desfechos do B7: recusado antes da escrita = `NOT_SENT`; 4xx/5xx = `FAILED`; 401/403 marcados; timeout ou conexão caída depois do envio = `UNCERTAIN`; JSON inválido ou fora do enum = `OK` com `parse = OUT_OF_ENUM`
- [x] A chave só aparece no header; mensagens de erro passam pelo scrub (parte do AC-06)

**Verificação:** `node --require ./harness/loopback-only.cjs --test scripts/lib/jev-client.test.js`
**Dependências:** nenhuma
**Arquivos:** `scripts/lib/jev-client.js`, `.test.js` (o fake HTTP fica num helper de teste, como os `createServer` de `bitbucket-pr.test.js`)
**Tamanho:** M

**Feito (2026-11-06):** `jev-client.test.js` 18/18 em Node 22.23.2 e 24.22.1, com um fake HTTP em 127.0.0.1. Cobre: corpo só com os 3 campos, pergunta e modelo; chave só no header; OK; OUT_OF_ENUM (classe fora do enum e JSON inválido); confiança fora de faixa vira null; 500; 401 e 403 com `auth_rejected`; conexão recusada = NOT_SENT; timeout e conexão caída depois do envio = UNCERTAIN; sem credencial nada sai; a chave não aparece em nenhum desfecho; PROMPT e hash estáveis; destino fixo; Keychain por `/usr/bin/security` sem shell, com falha sem detalhe; com o loopback ativo, o destino real é recusado (NOT_SENT). Também inclui `readKeychainCredential` (AD-4). O formato da API segue não verificado contra a documentação oficial (P-3: teste de fumaça manual).

## Checkpoint A
- [x] T1 a T3 verdes; o fake nunca vê rede externa; a revisão rápida dos três módulos sai antes da Fase 2 — 164/164 com `model-routing`, `routing-config` e `dom06-attempt` (Node 22 e 24); `lint:src`, `check:js` e `arch:check` limpos; autorrevisão feita, revisão independente fica para o Checkpoint C

## T4: config e policy do jev

**Descrição:** `validateRoutedPolicy` passa a exigir, quando `provider = jev`, a
seção completa: `mode ∈ {shadow, active}`, `model_id`, `timeout_ms ≤ 5000`,
`prompt_ref {id, version, sha256}` igual ao `promptSha256` do cliente,
`enum_version` e `destination` fixo. `readRoutingConfig` lê
`classifier_credential {keychain, account}` (só nomes; recusa chaves com cara de
valor, como no `db-effect.js:74`) e `authority_ref {id, sha256, path}`.

**Aceite:**
- [x] ~~Policy jev incompleta → `POLICY_INVALID` com o detalhe; p1 (`cheap_rule`) continua válida, igual a hoje~~ **Desvio (SPEC vence o plano):** a seção jev incompleta **não** invalida a policy. Ela é validada à parte por `validateClassifierSection`; o detalhe vai para a admissão (T5), que deixa o núcleo 2 `off`. Motivo: policy inválida com `mode = ON` bloqueia a admissão da Run (RC-5), e o SPEC §B2 diz que nada do núcleo 2 bloqueia.
- [x] ~~Config com `password`, `token`, `key` ou valor literal → `ROUTING_CONFIG_INVALID`~~ Pelo mesmo motivo, vira erro em `classifier_config.errors` (`classifier_credential_invalid`, `authority_ref_invalid`, `authority_ref_path_outside_root`), sem ecoar o valor; o núcleo 2 fica `off`.
- [x] Os testes atuais de `routing-config` e `model-routing-policy` passam sem mudança

**Verificação:** `node --test scripts/lib/routing-config.test.js scripts/lib/routing-off-golden.test.js`
**Dependências:** T3 (`promptSha256`)
**Arquivos:** `scripts/lib/model-routing-policy.js` e testes
**Tamanho:** S

**Feito (2026-11-06):** `routing-config.test.js` 50/50 (20 casos novos). Com `routing-*`, `model-routing`, `cost-tracking`, `would-route`, os `classifier-*` e `jev-client`: 264/264 em Node 22.23.2 e 24.22.1. O snapshot e o hash de uma Run `cheap_rule` não mudam (`buildRoutingSnapshot` não lê `classifier_config`). `lint:src`, `check:js` e `arch:check` limpos.

## T5: Authority Ref e admissão

**Descrição:** `classifier-authority.js` valida o espelho (hash, `revoked_at`,
vigência, destino, envelope, `scope.projects`). `buildRoutingSnapshot` recebe o
resultado e grava `classifier_effective {provider, mode, reason, authority_ref}`.
`mode = active` vira `shadow` com `ACTIVE_NOT_CALIBRATED`. Há também um
`isRevoked(ref)` relido a cada Attempt (Q4).

**Aceite:**
- [x] Cada linha da tabela do B2 tem um teste (AC-07); nenhum caso bloqueia a admissão
- [x] O snapshot e o hash de uma Run `cheap_rule` ficam idênticos aos de `4d39a3c`
- [x] Revogação no meio da Run: o próximo Attempt fica `off`, e o já iniciado não muda

**Verificação:** `node --test scripts/lib/classifier-authority.test.js scripts/lib/model-routing.test.js`
**Dependências:** T4
**Arquivos:** `scripts/lib/classifier-authority.js`, `scripts/lib/model-routing.js`, testes
**Tamanho:** M

**Feito (2026-11-06):**
- `classifier-authority.test.js` tem 24 testes: todas as linhas do B2, `active` virando sombra, guarda indisponível, a função nunca lança, Q4 (espelho inalterado, revogado, mudado, ausente) e o snapshot.
- Teste novo no watcher (`routing-admission-watcher.test.js` › "S3b T5 / AC-07"): uma policy `jev` sem Authority Ref é admitida e despacha igual, e o snapshot registra `off` com `AUTHORITY_REF_ABSENT`.
- Conjunto de roteamento, DOM-06 e núcleo 2: 313/313 em Node 22.23.2 e 24.22.1. `lint:src`, `check:js` e `arch:check` limpos.

**Decisões de implementação:**
- `evaluateClassifier` devolve `null` para `off`/`cheap_rule`, e então o snapshot fica igual ao da S4.
- A identidade do projeto em `scope.projects` é o nome da pasta do `REPO_PATH` (ex.: `app-back`). O espelho da Q9 deve usar esse nome.
- Q4: qualquer mudança nos bytes do espelho para o envio a partir do próximo Attempt. Se o espelho novo traz `revoked_at`, o motivo é `REVOKED`; nos outros casos, `CHANGED`. Isso resolve a tensão entre "hash conferido" e "o espelho muda ao revogar".
- A ligação da Q4 a cada Attempt fica com a T6/T7.

## T6: orquestração em sombra com Attempt de efeito

**Descrição:** `collectOpinions({runDir, snapshot, groups, visit, client, credentialProvider})`
aplica, por grupo elegível e priorizado: envelope → verificador → `beginAttempt`
(`node: classifier`, EffectId com `rep_index`) → `classify` → `recordEffect` →
`closeAttempt`. Reusa a opinião `COMPLETE` da mesma EffectId, nunca repete
`FAILED`/`UNCERTAIN` na visita, grava o envelope em AD-7 e o marcador de AD-6 em
401/403.

**Aceite:**
- [x] O Attempt de efeito existe antes de o fake receber a requisição; o fecho corresponde ao B7 (AC-08)
- [x] Timeout → `UNCERTAIN` e nenhuma segunda requisição, nem no retry da mesma visita (AC-09)
- [x] 401/403 → efeito revogado e a Run fica `off` daí em diante (AC-10); em todos os desfechos o `summarize` do Implement fica sem obrigação nova (AC-11)

**Verificação:** `node --require ./harness/loopback-only.cjs --test scripts/lib/classifier-shadow.test.js`
**Dependências:** T1, T2, T3, T5
**Arquivos:** `scripts/lib/classifier-shadow.js`, `.test.js`
**Tamanho:** M

**Feito (2026-11-06):** `classifier-shadow.test.js` 13/13. Cobre:
- caminho feliz (zona cinzenta e sonda);
- `wouldClass` com as regras do §4.8 só como registro;
- AC-08 com o cliente real contra um fake HTTP: o servidor vê o Attempt `classifier` em `STARTED` antes de responder;
- guarda bloqueando sem chamada nem Attempt (AC-05);
- os quatro desfechos do B7;
- AC-09: `UNCERTAIN` não se repete, `COMPLETE` é reusado, visita nova chama de novo;
- `rep_index` dando efeitos distintos;
- AC-10: revoga, grava o marcador e desliga a Run;
- AC-11: o Attempt do Implement fica byte a byte igual nos quatro desfechos;
- efetivo `off`, Q4 revogado, sem credencial;
- Q6/AC-06: o envelope fica só na Run, a chave não é gravada;
- teto de 3;
- cliente que lança vira `ERROR` e o Attempt fecha `UNCERTAIN`.

Conjunto de roteamento, DOM-06 e núcleo 2: 326/326 em Node 22.23.2 e 24.22.1. `lint:src`, `check:js` e `arch:check` limpos.

**Decisões de implementação:**
- A resposta compacta do Jev vai no `detail` do efeito, em JSON. Assim o contrato do `dom06-attempt` não muda.
- A credencial é lida uma vez por coleta, e antes de qualquer Attempt. Se faltar, nada é emitido.

## Checkpoint B
- [x] Suíte `scripts` inteira verde; AC-03 a AC-11 automatizados

**Feito (2026-11-06):** receita oficial (`env -i`, HOME/TMPDIR sintéticos, `NODE_OPTIONS=--require=harness/loopback-only.cjs`).
- **Node 22.23.2:** 1470 pass, 0 fail, 6 skip de ambiente (docker, poppler, template).
- **Node 24.22.1:** 1470 pass, 1 fail no `after` de `routing-off-golden.test.js` (`ENOTEMPTY` ao apagar o tmp depois de um teste de 97 s). O teste do golden em si passou. Sozinho, o arquivo passou 2/2 (~23 s). Ele não mudou desde `4d39a3c`: corrida de limpeza sob carga, preexistente.
- A primeira rodada teve 6 falhas porque o worktree estava sem `dashboard/node_modules` (`express`, `typescript`). Rodou de novo depois de `npm ci` no dashboard.
- O teste do destino real sob loopback (`jev-client`) rodou na suíte oficial: o preload vem por `NODE_OPTIONS`. Isso fecha a pendência do Checkpoint A.

TAPs em `prisma-evidence/2026-11-06-pri-205-s3b-jev/checkpoint-b/`.

## T7: RoutingDecision e ligação no watcher

**Descrição:** `resolveRoute` aceita `input.nucleus2` e grava, por grupo,
`nucleus2 {status, reason, probe, effect_attempt_id, class_suggested, confidence,
risky, would_class, direction}`, além de `nucleus2_would_node_class` e do
`classifier_ref` com os 8 campos. O watcher chama `collectOpinions` com `await`
antes da `resolveNodeRoute` do Implement (`readmine-watcher.js:4816`), dentro da
reserva do nó.

**Aceite:**
- [x] AC-02: `class`, `selection_source`, `candidates`, `chosen` e argv são iguais com e sem núcleo 2, inclusive com resposta C1 e confiança 0,99
- [x] AC-01: com `provider ≠ jev` ou sem ref, o fake não recebe nada e não nasce Attempt `classifier` (teste de watcher)
- [x] AC-12: os 8 campos estão iguais no snapshot e em cada Attempt; sem versão reportada, `UNKNOWN`

**Verificação:** `node --require ./harness/loopback-only.cjs --test scripts/lib/model-routing.test.js scripts/lib/routing-admission-watcher.test.js`
**Dependências:** T5, T6
**Arquivos:** `scripts/lib/model-routing.js`, `scripts/readmine-watcher.js`, testes
**Tamanho:** M

**Feito (2026-11-06):**
- `model-routing.test.js`: 6 testes novos, mais os testes A3/A4 da S4 ajustados ao formato novo de `classifier_ref`, que mantém `declared`, `nucleus2_effective` e `reason`.
  - AC-12: os 8 campos aparecem em toda decisão. Com Jev efetivo, são iguais entre Attempts; o alias vira `model_version = UNKNOWN`; com efetivo `off`, vale o motivo do snapshot.
  - AC-02: classe, origem, candidatos, escolhido e argv iguais com e sem núcleo 2, mesmo com uma resposta C1 de confiança 0,99.
  - B8: `nucleus2` por grupo e `nucleus2_would_node_class`. Ficam `null` sem núcleo 2 e em nó fixo.
- `plan-signals.test.js`: 3 testes novos de `classifierEnvelopes`. O passo com bloco de código vira `STEP_HAS_CODE_BLOCK`; AC fora da spec não entra no envelope.
- `classifier-shadow.test.js`: +1 (`NO_ENVELOPE`).
- `routing-admission-watcher.test.js`: +2.
  - Jev efetivo e item do Keychain inexistente: o grupo elegível (sonda) fica `CREDENTIAL_UNAVAILABLE`, nenhum Attempt `classifier` é criado, e o argv segue a escolha do núcleo 1.
  - `cheap_rule`: `nucleus2` fica `null` e nenhum Attempt `classifier` é criado.
- Conjunto: 385/385 em Node 22.23.2 e 24.22.1. `lint:src`, `check:js` e `arch:check` limpos.

**Decisões de implementação:**
- A coleta (`collectNucleus2` no watcher) roda antes de `resolveNodeRoute`, só no Implement e só com o Jev efetivo no snapshot. Ela nunca roda em `--dry-run` nem em simulação, e fica sob a reserva do ticket (`dispatchTicket`).
- A visita é `implement@<início da visita>` (`routingRun.nodeVisitStart`).
- O parâmetro `authorityRef` saiu da `resolveRoute`: a autoridade agora vem do snapshot.
- O envelope é gravado na Run antes da leitura da credencial, para o U15.

## T8: comando U15

**Descrição:** `scripts/jev-calibrate.js --runs <dir> --n 5 --max-calls <k>
[--synthetic]` lê os envelopes de AD-7, faz as repetições `rep_index` 1..N por
`collectOpinions` e imprime só agregados.

**Aceite:**
- [x] AC-13: fake determinístico dá 100%; fake alternado dá a taxa esperada; `--max-calls` é obrigatório e respeitado; repetições `COMPLETE` não se refazem
- [x] Respostas faltantes saem como `UNKNOWN`, nunca como concordância
- [x] A saída não contém texto de envelope

**Verificação:** `node --require ./harness/loopback-only.cjs --test scripts/lib/jev-calibration.test.js` (a lógica fica em `scripts/lib/jev-calibration.js`, coberta pelo `lib/*.test.js` do `npm test`; `scripts/jev-calibrate.js` é só o CLI)
**Dependências:** T6
**Arquivos:** `scripts/jev-calibrate.js`, `.test.js`
**Tamanho:** S

**Feito (2026-11-06):** `jev-calibration.test.js` 9/9. Cobre:
- fake determinístico: 5/5, taxa 1, PASS, 10 efeitos com `rep_index` 1..5;
- fake alternado: moda 0,6, taxa 0, FAIL;
- `--max-calls` respeitado: o que faltou fica UNKNOWN, e rodar de novo completa só o que faltava;
- resposta incerta: conta como faltante e nunca é refeita;
- erros de uso; núcleo 2 `off`;
- relatório sem texto nem chave; envelope adulterado é pulado;
- `--synthetic` (teste de fumaça P-3);
- o CLI sem `--max-calls` sai com 2.

Conjunto: 394/394 em Node 22 e 24. `lint:src`, `check:js` e `arch:check` limpos.

**Decisões de implementação:**
- Extraí `emitOnce`/`priorOutcome` do `classifier-shadow`: o despacho e o U15 usam o mesmo registro de efeito. Os 14 testes da T6/T7 seguem verdes.
- As repetições vão para um diretório próprio (`<runs>/_jev-u15` por padrão, ou `--out`), não para os Attempts da Run.
- A EffectId do U15 é `['U15', envelope, prompt, modelo, rep]`, independente da visita.
- `OUT_OF_ENUM` conta como resposta distinta: quebra a igualdade, mas não é faltante.
- A config é avaliada na hora (Authority Ref atual). Sem núcleo 2 efetivo, o CLI sai com 3 e não envia nada.

## T9: consumidores, documentação e proposta da p2

**Descrição:** garantir que `cost-projection.js` e `routing-run.js` ignorem ou
mostrem o nó `classifier` sem quebrar; documentar em `docs/consumer-operations.md`
a ativação (Authority Ref, item no Keychain **sem** colar o valor em lugar nenhum,
seleção "Policy + Jev" pelo Dashboard, e como desligar com "Só policy"), e que
`memory/routing/` fica fora do git do consumidor. ~~Gerar a proposta da p2~~ (Q12:
não é mais necessária).

**Aceite:**
- [ ] AC-14: receita oficial verde em Node 22 e 24; `check:js`, `lint:src` e `arch:check` limpos
- [ ] AC-06: varredura dos arquivos gravados nos testes sem a chave falsa
- [x] ~~A proposta p2…~~ Não se aplica (Q12)

**Verificação:** `node harness/run-tests.js` (Node 22 e 24)
**Dependências:** T7, T8
**Arquivos:** `dashboard/cost-projection.js` (se preciso), `docs/consumer-operations.md`, testes
**Tamanho:** S

## T10: registro de seleção e writer governado

**Descrição:** `scripts/lib/classifier-selection.js`: `readSelection(root)`,
`effectiveClassifier(root, policy)` (registro ou policy) e `writeSelection(root,
{choice, mode, expectedVersion, operationId, by, reason, project, classifierConfig})`
com as validações 0–5 do B11, na ordem, e gravação atômica com auditoria.

**Aceite:**
- [x] AC-15: `policy_only` → `{provider: off}`; `policy_jev` → seção completa da plataforma; sem registro vale a policy
- [x] AC-16: um teste por código de recusa, na ordem (idempotência antes do CAS; `active` sempre `CLASSIFIER_NOT_CALIBRATED`; jev sem ref `CLASSIFIER_SCOPE_NOT_AUTHORIZED`)
- [x] AC-17: auditoria completa por versão; concorrência com a mesma `expected_version` → um grava, o outro 409

**Verificação:** `node --test scripts/lib/classifier-selection.test.js`
**Dependências:** T5
**Arquivos:** `scripts/lib/classifier-selection.js`, `.test.js`
**Tamanho:** M

**Feito (2026-11-06):** `classifier-selection.test.js` 21/21 em Node 22.23.2 e 24.22.1. Cobre:
- sem registro vale a policy;
- "Só policy" grava `off` com auditoria completa;
- "Policy + Jev" grava a seção da plataforma, que passa no `validateClassifierSection`;
- ordem 0: idempotência antes do CAS;
- ordem 1: CAS, e a mesma `expected_version` duas vezes;
- trava tomada → 409;
- ordem 2: jev sem ref → 422 com o motivo;
- ordem 3: `active` sempre 422;
- ordem 4: unidade S6 ativa → 422; sem registro grava `NO_REGISTRY`;
- 8 pedidos inválidos → 400;
- append-only com `previous_version`;
- registro quebrado → efetivo `off` e o writer não sobrescreve;
- `previewOptions` para a UI;
- `registryGitIgnored`.

Conjunto: 369/369. `lint:src`, `check:js` e `arch:check` limpos.

**Decisões de implementação:**
- A trava de escrita é um arquivo exclusivo (`.lock`). Se tiver mais de 60 s, é considerada abandonada e retomada uma vez.
- Registro ilegível → 409 `CLASSIFIER_SELECTION_INVALID`, sem sobrescrever.
- A trava de experimento lê `memory/routing/experiment-units.json` (ainda não existe). Se o arquivo estiver ilegível, a troca fica travada (fail-closed).

## T11: admissão lê o registro

**Descrição:** na admissão, o watcher usa `effectiveClassifier` no lugar de
`policy.classifier`, fixa `classifier_selection_ref {version, sha256}` no snapshot e o
`classifier_ref` ganha `selection_version`. Registro ilegível → `off` com
`CLASSIFIER_SELECTION_INVALID`, sem bloquear.

**Aceite:**
- [ ] AC-18: trocar a escolha não muda a Run em andamento; a próxima Run usa a versão nova
- [ ] Sem registro, snapshot e decisão iguais aos de hoje (golden do `mode` OFF e testes da S4 verdes)
- [ ] Registro quebrado → `off` com motivo, admissão segue

**Verificação:** `node --require ./harness/loopback-only.cjs --test scripts/lib/routing-admission-watcher.test.js scripts/lib/model-routing.test.js`
**Dependências:** T10
**Arquivos:** `scripts/readmine-watcher.js`, `scripts/lib/model-routing.js`, testes
**Tamanho:** S

## T12: API do seletor no Dashboard

**Descrição:** `GET /api/routing/classifier` e `POST /api/routing/classifier` no
`dashboard/server.js`, no padrão do `routing-override` (`requireApprover`,
`operation_id`, recusa com código). Contrato enviado à sessão `routing-screens`.

**Aceite:**
- [ ] AC-19: GET com estado, opções e motivo previsto da recusa; POST aplica, devolve `already_processed` na repetição e recusa com 400/409/422 e o código
- [ ] Sem aprovador válido → 401/403/429 como hoje; nada é gravado
- [ ] Testes do dashboard verdes em Node 22 e 24

**Verificação:** receita do pacote `dashboard`
**Dependências:** T10, T11
**Arquivos:** `dashboard/server.js`, teste novo em `dashboard/`
**Tamanho:** M

## Checkpoint C (fechamento)
- [ ] Revisão independente G2 (Claude Opus, contexto limpo, sem Codex) com os achados resolvidos
- [ ] `tasks/pri-205-s3b/evidence.md` com o estado de cada AC
- [ ] Handoff (`templates/handoff.yaml.template`) validado; commit; PR em draft; o merge é exclusivo do Richard
