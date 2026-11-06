# Spec: PRI-205 S3b — núcleo 2 da classificação com o Jev (TypeSafe) em modo SOMBRA

> **Status:** APROVADA pelo Richard em 2026-11-06 ("Approve, start plan"). Q0 a Q10 decididas (tabela
> "Decisões tomadas nesta spec"). **Ampliada em 2026-11-06 pela R-SEL (seletor, B11) com Q11–Q14 decididas pelo Richard.** Plano em `tasks/pri-205-s3b/plan.md`. A spec
> não é Ready da issue, não aplica RC-1 a RC-6 (todos NOT APPLIED), não altera o
> desenho v9, a F13 nem a policy aprovada `routing-pri205@p1-2026-11-06`.
> `roadmap-ref: UNKNOWN` (D-3: registro no Linear, sem Roadmap).
> Issue: `PRI-___` (a criar com a sua confirmação; filha da PRI-205).
>
> **Fontes:** desenho v9 (`~/Workspace/prisma-evidence/pri-205/desenho-selecao-modelo.md`,
> SHA-256 `2d8919fe…`, o mesmo do `design_ref` da policy aprovada), §2.2 (V7-02),
> §4.4, §4.7, §4.8, D20, D21, D23, U15; PRI-205 (DP-9 a, U-A1, R-2, R-3, R-4, R-7,
> D-6); `hd-ativacao-final-proposta.md` (gate da "S3, núcleo 2"),
> `tratamento-unknowns-hd-final.md`, `recomendacao-dp9-jev.md`, `plano-fatias.md`;
> código em `origin/main` `4d39a3c` (PR #97 e #99): `scripts/lib/model-routing.js`,
> `model-routing-policy.js`, `would-route.js`, `dom06-attempt.js`, `db-effect.js`,
> `scripts/readmine-watcher.js:1626-1670`, `harness/loopback-only.cjs`. API do Jev
> conhecida só pela leitura do plugin `thinkdial` (`hooks/policy.ts`, MIT): nada
> dele é copiado nem chamado.

## Contexto

Hoje o roteamento (S4, PRI-233) classifica cada grupo do plano só com o núcleo 1
(R1–R8). A zona cinzenta cai em C4 (Opus), que é o lado seguro. Nenhum código
chama o Jev: `classifier.provider = jev` numa policy roteada vira `off` na
resolução (`model-routing.js:145-150`, AC-11 da S4), com `reason =
AUTHORITY_REF_ABSENT` porque o watcher passa `authorityRef: null`
(`readmine-watcher.js:1665`). O loader da S3 recusa `jev` de vez
(`model-routing-policy.js:57`).

**Enquadramento (Richard, 2026-11-06): custo × qualidade, não só economia.** O
§4.8 dá dois sentidos ao núcleo 2: **subir** a classe "sempre", com confiança
≥ 0,3 (lado da qualidade), e **descer** da zona cinzenta só com confiança ≥ 0,6,
depois da calibração e no máximo uma classe (lado do custo). O desenho tem uma
tensão: a tabela do §4.8 diz que subir vale "sempre", mas as validações 0–5
exigem `calibration_ref` para qualquer `jev` em `active`, ou seja, para qualquer
efeito. Essa tensão é a pergunta Q0. Em qualquer opção é preciso dado de
calibração, e o Richard quer começar a acumulá-lo já, em paralelo com a S5. Esta fatia é a
"S3, núcleo 2" do gate da HD-AF-078: ela é a SDD que a PRI-205 pede para o U-A5
(R-4: onde registrar o efeito) e para a verificação fail-closed do R-7.

## Objetivo

Numa Run admitida com `routing.mode = ON` e com uma policy cuja seção
`classifier` declara `provider = jev`, `mode = shadow`, o Prisma pergunta ao Jev,
**antes do spawn**, a classe de cada grupo do Implement que está na zona
cinzenta. A resposta é gravada na RoutingDecision do Attempt (`classifier_ref` e
opinião por grupo) e num Attempt de efeito próprio. **Nada no despacho muda:**
argv, modelo, classe e `selection_source` são os mesmos que seriam sem o Jev.
Falha, timeout, recusa de autorização ou do guarda de conteúdo nunca bloqueiam o
despacho e nunca repetem uma chamada de resultado incerto. Um comando separado
mede a reprodutibilidade (U15) sobre as entradas gravadas.

**Decidido pelo Richard em 2026-11-06 (Q0 e Q0'): "(b) + shadow on C1–C3".**
Tudo fica em sombra até a calibração, e o Jev também opina, em sombra e só no
sentido de subir, nos grupos C1–C3 (B3, G3). Isso amplia a zona de atuação do
§4.8 e volta à reconciliação do RC-6 como delta do desenho (AGENTS.md regra 8).
A ampliação não produz efeito no despacho.

**Este objetivo é o da opção (b) da Q0 (tudo em sombra).** Na opção (a), a fatia
passa a ter **modo misto**: a subida com confiança ≥ 0,3 tem efeito na resolução
(`selection_source = CLASSIFIER_UPGRADE`, classe e `chosen` recalculados, efeito
gravado na RoutingDecision junto do `classifier_ref`), e a descida continua só
registrada em `would_class`. AC-02 vira "a descida nunca muda o despacho" e entram
ACs de subida (a resolução sobe de tier pela ordem da policy; falha do Jev = classe
do núcleo 1; a subida nunca desce nada). Ver também o achado da Q0 sobre o efeito
prático da subida na policy p1.

**Sucesso:** (1) com `provider ≠ jev`, ou sem Authority Ref válida, nada é
enviado e o comportamento é idêntico ao de `4d39a3c`; (2) com tudo válido, cada
grupo da zona cinzenta tem exatamente uma opinião (ou uma falha registrada) por
visita ao nó, sem efeito no despacho; (3) o comando U15 produz, para cada entrada,
5 respostas e a taxa de concordância do enum.

## Decisões tomadas nesta spec (Richard, 2026-11-06)

| ID | Decisão |
| -- | -- |
| Q0 | (b): tudo em sombra até a calibração. Custo × qualidade, não só economia |
| Q0' | Sonda de subida em sombra também nos grupos C1–C3 (G3). Amplia o §4.8; vai para a reconciliação do RC-6 (regra 8) |
| Q1 | Só em Runs com `mode = ON` |
| Q2 | ~~Propor no plano a `routing-pri205@p2`~~ **Substituída pela Q12:** a p2 não é necessária; a p1 fica como está |
| Q3 | Excluir também `rework` e `sensitive_decl = UNKNOWN` (já refletido no B3) |
| Q4 | A revogação da Authority Ref vale a partir do próximo Attempt; é o único dado relido fora do snapshot |
| Q5 | Pergunta = escolha entre as classes C1–C5, com critérios em texto, mais o `noul` de risco |
| Q6 | O envelope fica guardado só no diretório da Run do consumidor, para o U15 |
| Q7 | O verificador do B5 é aceito como a verificação do R-7, com o limite declarado (UNK-SEC-007 OPEN) |
| Q8 | `timeout_ms` = 3000, no máximo 3 grupos por visita (G1/G2 antes de G3), sem teto diário; `--max-calls` só no U15 |
| Q9 | Authority Ref registrada pelo Coordenador no Linear (DP-7), com espelho e hash no consumidor; até existir, a fatia fica desligada (`AUTHORITY_REF_ABSENT`) |
| Q10 | Em sombra, aceita `model_version = UNKNOWN` se só houver `jev-latest`; o modo ativo exige um id fixo ou uma decisão nova |
| R-SEL | **Requisito novo do Richard (2026-11-06, via sessão coordenadora):** "deve ter como selecionar as duas opções tanto usar o jev quanto só usar a policy". O seletor (D23/S7d, §4.8) **entra** nesta fatia: contrato, writer governado e endpoint. A tela é da sessão `routing-screens` |
| Q11 | A escolha fica num **registro próprio** do consumidor, append-only, em `memory/routing/classifier-selection.json`, fora do git e fora da policy (o hash da p1 não muda). Entra no snapshot da Run e no `classifier_ref` (B11) |
| Q12 | Os parâmetros do Jev (modelo, timeout, prompt, enum, destino) vêm **da plataforma** (constantes do `jev-client` desta versão) e são gravados em cada versão do registro. **A p2 deixa de ser necessária** (substitui a Q2) |
| Q13 | Escopo **por projeto consumidor**, como o `mode` do roteamento (SP-3) |
| Q14 | Quem troca: **aprovador autenticado**, como no override de roteamento (nome e senha, bloqueio após tentativas, CAS, `operation_id`) |

## Fora de escopo

- Modo `active` para a **descida** (o lado do custo), em qualquer opção da Q0.
  Na opção (b), também para a subida. `active` declarado sem calibração vale
  como `shadow`, com o motivo registrado (§4.8, defesa na admissão).
- A **tela** do seletor no Dashboard (sessão `routing-screens`). ~~Seletor e writer~~: entraram pela R-SEL (B11).
- Esforço (U1, SP-1 revista) e `haiku` como classificador (vale `off`).
- O plugin `jev-model-router`: continua desligado em todo despacho roteado pelo
  `--settings` gerado (`claude-account.js`, SP-2). Ele não é o mecanismo daqui.
- Calcular o **acerto** (b) da calibração: exige o desfecho por subtarefa, que só
  existe com a S5. Esta fatia grava as chaves de junção para isso (ver Q6).
- Runs com `mode` ausente ou `OFF` (decisão sombra `would_route` da S3): ver Q1.
- Aplicar o RC-6 ou criar o DOM-07. A fatia usa o registro decidido no R-4 e
  declara onde ele não cobre o DOM-07 (§ Conformidade).

## Comportamento

### B1. Configuração (o que é config, o que é autoridade, o que é segredo)

| Item | Onde fica | Observação |
| -- | -- | -- |
| `classifier = {provider: "jev", mode: "shadow", model_id, timeout_ms, prompt_ref {id, version, sha256}, enum_version, destination: "typesafe:/v1/systemone"}` | **registro de seleção do consumidor** (B11, Q11/Q12), com os parâmetros da plataforma; sem registro, vale a seção da policy (hoje `cheap_rule`) | entra no snapshot da Run; vale só para Runs novas (F5) |
| Referência da credencial: `{"keychain": "prisma-jev-typesafe", "account": "typesafe"}` | config do consumidor (`.claude/model-routing.json`, campo novo `classifier_credential`) | **só o nome do item do Keychain**; o valor nunca está no repo, na policy, no snapshot, no Attempt nem em log. Precedente: `db-effect.js:60-80` (segredo só no Keychain, serviço derivado do nome) |
| Authority Ref do envio | registro durável próprio (B2) | não é config: config não autoriza nada (AGENTS.md regra 6) |

- O cliente lê a chave só na hora da chamada, pelo `/usr/bin/security`
  (caminho absoluto, como `db-exec-child.js`). Nunca lê `~/.claude*/settings.json`
  nem a config do plugin. Se o item não existir ou não puder ser lido sem diálogo
  → nada é enviado (`CREDENTIAL_UNAVAILABLE`), certo, sem efeito.
- A chave vai só no header `Authorization` da requisição. Mensagens de erro são
  truncadas e passam pelo mesmo `scrub` do `db-effect` antes de gravar.
- `destination` é fixo: `https://api.typesafe.ai/v1/systemone`. A URL não é
  configurável em produção; o teste injeta a base por parâmetro de função, não
  por env (B8).

### B2. Authority Ref e reavaliação na admissão

Hoje não existe Authority Ref durável (DP-7: o Coordenador registra; ainda não
registrou). A fatia define a **forma** e a **verificação**, não cria a autoridade:

```
authority_ref = {
  id, issued_by: "Richard Fernandes", issued_at,
  source: [ "PRI-205 D20 (2026-10-20)", "PRI-205 U-A1 (2026-10-26)", "R-2/R-3 (2026-10-26/27)" ],
  destination: "typesafe:/v1/systemone",
  envelope: { allow: ["step_text", "ac_text", "declared_paths"], never: ["code", "customer_data", "personal_data", "secrets", "credentials"] },
  scope: { projects: [...] },           // inclui M&O por decisão do Richard
  valid_from, revoked_at: null, sha256
}
```

Na **admissão da Run** (mesmo ponto em que o snapshot `routing` é fixado), com
`classifier.provider = jev`:

| Verificação | Falha → | Efeito |
| -- | -- | -- |
| Authority Ref presente, hash íntegro, não revogada, vigente | `AUTHORITY_REF_ABSENT` / `_INVALID` / `_REVOKED` | núcleo 2 efetivo = `off` na Run inteira |
| `destination` e `envelope` da ref cobrem os da policy | `AUTHORITY_REF_SCOPE_MISMATCH` | idem |
| projeto da Run está em `scope.projects` | `AUTHORITY_REF_SCOPE_MISMATCH` | idem |
| `classifier.mode = active` | — | efetivo = `shadow`, `reason = ACTIVE_NOT_CALIBRATED` |
| guarda de conteúdo aceito (B5) existe nesta versão do Prisma | `CONTENT_GUARD_UNAVAILABLE` | `off` |

O resultado vai para o snapshot como `classifier_effective = {provider, mode,
reason, authority_ref: {id, sha256}}`. **Nenhum desses casos bloqueia a admissão
da Run nem o despacho** (o núcleo 2 é opinião). Resolução por Attempt nunca relê
a ref corrente: usa a do snapshot (F5), exceto revogação (Q4).

### B3. Zona cinzenta (quando o Jev é perguntado)

Calculada sobre a saída do núcleo 1 de cada grupo, de forma determinística e
testável. Um grupo está na zona cinzenta se **nenhuma** exclusão vale e vale G1
ou G2:

- **Exclusões (soberanas):** `sensitive_decl ∈ {true, UNKNOWN}`; R1; R2;
  `schema_decl ≠ false`; `kind ∈ {behavior, config}`; `n_services_decl ≥ 2`;
  `rework` (Q3); classe final vinda do Plan maior que a calculada.
- **G1 (falta de sinal não-segurança):** regra R3, com `sensitive_decl = false`,
  e o(s) sinal(is) UNKNOWN só entre `{n_files, kind, n_acs_step, n_new_files,
  code_local}`.
- **G2 (a um critério da classe abaixo):** regra R8, ou R4 disparada **só** por
  `n_files > 5`, e existe C ∈ {C3, C2} cuja regra (R7, R6) falha em exatamente um
  predicado numérico (`n_files`, `n_acs_step`, `n_new_files`) por exatamente 1
  unidade (ex.: 6 arquivos contra o corte de 5).

- **G3 (sonda de subida, Q0' decidida):** a classe final do núcleo 1 é C1, C2 ou
  C3 (R5, R6, R7) e nenhuma exclusão vale. Para esses grupos só a subida é
  registrada: `would_class = max(classe, sugerida)` com confiança ≥ 0,3. Uma
  sugestão menor que a classe vira `would_class = classe` e
  `direction = DOWN_IGNORED`. O campo `probe` distingue `GRAY` (G1/G2) de
  `UPGRADE_PROBE` (G3).

Fora de G1, G2 e G3 o Jev não é chamado e o grupo registra
`nucleus2: {status: "NOT_ELIGIBLE", reason: <exclusão ou NOT_GRAY>}`.
Só o nó Implement tem grupos; os demais nós usam o `default_route` e nunca chamam.

### B4. Envelope e pergunta

- **Envelope** (R-2): texto do passo do plano, texto dos ACs citados pelo passo,
  caminhos declarados (`paths_decl`). Nada de código, diff, conteúdo de arquivo,
  ticket inteiro, nome do projeto, ids do Redmine ou dados do Attempt.
- **Pergunta** (versionada, `prompt_sha256`): uma `choice` com as cinco classes
  C1–C5 e os critérios de cada uma em texto, mais um `noul` de risco. O enum
  devolvido é a classe (Q5). A resposta válida é
  `{class ∈ C1..C5, confidence ∈ [0,1] | null, risky ∈ [0,1] | null}`; qualquer
  outra forma é `OUT_OF_ENUM`.
- `envelope_sha256` = SHA-256 canônico do envelope; vai no registro. O texto em
  si fica só no diretório da Run do consumidor (Q6), nunca na telemetria
  exportada nem no repositório da plataforma.

### B5. Guarda de conteúdo (R-7, fail-closed)

Antes de qualquer envio, o envelope passa por um verificador determinístico. Se
ele achar qualquer ocorrência, **nada é enviado** (`CONTENT_GUARD_BLOCKED`, com a
categoria, sem o trecho). Ele **não** redige nem mascara: sanitizar não
desclassifica (F19 D-F19-14).

Categorias mínimas: chaves e tokens (prefixos conhecidos, `Bearer`, JWT, PEM,
`AKIA…`, strings de alta entropia ≥ 32), credenciais em URL (`user:pass@`),
connection strings e DSNs, e-mail, CPF/CNPJ (com dígito verificador), telefone
BR, IPv4/IPv6 não loopback, IBAN/cartão (Luhn). Caminhos declarados passam pelo
mesmo verificador.

**Limite declarado:** o verificador **não prova** a ausência de dado de cliente
ou pessoal (UNK-SEC-007 OPEN). Ele só reduz o risco nas categorias acima. O R-7
exige que o Richard **aceite** esta verificação como a definida (Q7). Sem o
aceite, B2 dá `CONTENT_GUARD_UNAVAILABLE` e nada é enviado.

### B6. Registro do efeito (R-4, U-A5)

Reusa o "Attempt de efeito" existente, como `db-effect.js:366-404`: cada chamada
ao Jev é um Attempt próprio, `node = "classifier"`, gravado em
`<task>/dom06/attempts/`, com:

- `snapshot = {task_id, routed_node, visit, subtask_key, envelope_sha256,
  classifier_ref, authority_ref {id, sha256}, rep_index}`;
- `obligations = [{id: "classifier_call"}]`;
- `idempotency_key = EffectId = sha256(task_id, routed_node, visit, subtask_key,
  envelope_sha256, prompt_sha256, rep_index)`. O índice de repetição está na causa
  (R-4), então as 5 repetições do U15 são efeitos distintos;
- **intenção durável antes da emissão:** o Attempt é persistido (`beginAttempt`)
  antes do `fetch`; o desfecho fecha com `closeAttempt` em `COMPLETE`, `FAILED`
  ou `UNCERTAIN`;
- resposta gravada: `{class, confidence, risky, model_reported, http_status,
  latency_ms}`; nunca o corpo bruto nem o envelope.

O Attempt do Implement **não** recebe obrigação nova: a falha do Jev nunca deixa
o nó `INCOMPLETE` (`summarize`, `dom06-attempt.js:417-446`). A RoutingDecision do
Implement referencia os Attempts de efeito por `attempt_id`.

### B7. Desfechos, timeout e não-repetição

| Situação | Certeza | Desfecho do efeito | Repete? |
| -- | -- | -- | -- |
| Guarda de conteúdo, credencial ausente, ref inválida | antes do envio | nenhum Attempt de efeito; motivo no grupo | — |
| Conexão recusada / DNS antes de escrever a requisição | certo (não enviado) | `FAILED` / `NOT_SENT` | não na mesma visita |
| HTTP 4xx/5xx recebido | certo | `FAILED` | não na mesma visita |
| HTTP 401/403 | certo | `FAILED` + revoga o Attempt de efeito; núcleo 2 `off` no resto da Run | não |
| Timeout (`timeout_ms`, padrão proposto 3000) ou conexão caída depois do envio | **incerto** | `UNCERTAIN` | **nunca** automaticamente |
| Resposta fora do enum / JSON inválido | certo | `COMPLETE` com `parse: OUT_OF_ENUM` | não |
| Saldo esgotado (USD 9, limite físico) | certo (resposta do servidor) | `FAILED` | não; conta como dado faltante, nunca aprovado |

- Retry do Implement **na mesma visita** reusa a opinião `COMPLETE` existente (mesma
  EffectId) e não chama de novo; `FAILED`/`UNCERTAIN` ficam como estão.
- A chamada roda na seção do despacho que já detém a reserva do nó
  (`dispatch-reservation`): só o tick dono emite.
- O tempo de espera soma ao despacho do Implement: no pior caso `timeout_ms` por
  grupo da zona cinzenta. Proposta: chamadas sequenciais, teto total de 3 grupos
  por visita (o resto fica `SKIPPED_BUDGET`) (Q8).

### B8. RoutingDecision e `classifier_ref`

`classifier_ref` (V7-02, todos os campos explícitos, copiado sem alteração do
snapshot para cada Attempt):
`{provider, model_id, model_version, prompt_sha256, enum_version, mode,
classifier_version, policy_sha256}`. `model_version` é o que o servidor
reportar; se não reportar, `UNKNOWN` (nunca o alias `jev-latest` como versão).

A RoutingDecision ganha, por grupo:
`nucleus2 = {status, reason, effect_attempt_id, class_suggested, confidence,
risky, would_class}`, em que `would_class` aplica as regras do §4.8 **só como
registro** (sobe com confiança ≥ 0,3; desce uma classe com ≥ 0,6). E no nível do
nó: `nucleus2_would_node_class` (máximo dos `would_class`). **`class`,
`selection_source`, `candidates` e `chosen` continuam calculados só pelo núcleo
1**; um teste prova a igualdade byte a byte com a decisão sem núcleo 2.

### B9. Reprodutibilidade (U15)

Comando manual `node scripts/jev-calibrate.js --runs <dir> --n 5 --max-calls <k>`:

- lê os envelopes da zona cinzenta gravados no diretório da Run do consumidor;
- para cada um, faz N = 5 chamadas, cada uma um Attempt de efeito com
  `rep_index` 1..5 (as já `COMPLETE` não se repetem; `UNCERTAIN` não se refaz);
- relata, por entrada e agregado: concordância do enum (moda/N), quantas
  respostas faltaram, e a taxa de entradas com 5/5 iguais; o limiar é ≥ 95%;
- `--max-calls` é obrigatório (saldo de USD 9); dados faltantes são `UNKNOWN`,
  nunca concordância;
- a saída é só agregada (hashes, contagens, classes), sem texto.

### B10. Testes (todos sob `harness/loopback-only.cjs`)

Fake do Jev = servidor HTTP em `127.0.0.1` porta efêmera, com roteiro de
respostas (válida, fora do enum, 401, 5xx, atraso > timeout, conexão caída
depois de ler o corpo, resposta não determinística para o U15). Credencial por
provedor injetado (fake do Keychain). Nenhum teste toca rede externa, Keychain
real ou texto real de ticket M&O.

### B11. Seletor "Só policy" × "Policy + Jev" (R-SEL; Q11–Q14)

**Registro.** `<consumidor>/memory/routing/classifier-selection.json`, append-only:
`{schema: "classifier-selection@1", project, current_version, versions: [{version, choice,
classifier, by, at, reason, previous_version, operation_id, payload_sha256, checks}]}`.

- `choice = "policy_only"` → `classifier = {provider: "off"}`: só o núcleo 1.
- `choice = "policy_jev"` → `classifier` completo do jev com os parâmetros da plataforma
  (Q12) e `mode ∈ {shadow, active}`.
- Sem registro (versão 0): vale `policy.classifier` (a p1 tem `cheap_rule`: só núcleo 1).

**Writer governado** (`classifier-selection.writeSelection`). Valida na ordem do §4.8 e
recusa com código:

| Ordem | Validação | Recusa |
| -- | -- | -- |
| 0 | `operation_id` já gravado: mesmo hash do pedido → devolve o resultado gravado, sem nova escrita; hash diferente → recusa | `CLASSIFIER_IDEMPOTENCY_MISMATCH` |
| 1 | `expected_version` igual a `current_version` (CAS) | `CLASSIFIER_VERSION_CONFLICT` |
| 2 | Para `policy_jev` (sombra ou ativo): Authority Ref válida para o projeto (mesma avaliação do B2), credencial referenciada no config e guarda disponível | `CLASSIFIER_SCOPE_NOT_AUTHORIZED` (com o motivo do B2) |
| 3 | Para `mode = active`: `calibration_ref` PASS igual campo a campo ao `classifier_ref`. **Não existe registro de calibração:** `active` é sempre recusado nesta fatia | `CLASSIFIER_NOT_CALIBRATED` |
| 4 | Nenhuma unidade S6 ativa no projeto. **Não existe registro de unidades** (PRI-236 em Backlog): passa, e grava `experiment_lock: "NO_REGISTRY"` | `CLASSIFIER_LOCKED_BY_EXPERIMENT` |
| 5 | Gravação atômica (arquivo de trava exclusivo, tmp + rename) da nova versão, com a auditoria (quem, quando, anterior, novo, motivo, `operation_id`, hash do pedido, resultado de 0–4) | — |

`policy_only` exige só 0, 1, 4 e 5. A UI só projeta o estado e o motivo da recusa; a guarda
é o writer.

**Admissão.** A Run lê o registro uma vez e fixa no snapshot `classifier_selection_ref
{version, sha256}`. O `classifier` efetivo (B2) é o do registro, ou o da policy sem
registro. A mesma regra de autorização é reavaliada na admissão (defesa em profundidade).
Uma troca só vale para Runs novas: Run em andamento mantém o snapshot, sem rebind. Registro
ilegível ou com hash quebrado → núcleo 2 `off` com `CLASSIFIER_SELECTION_INVALID`, sem
bloquear a admissão. O `classifier_ref` ganha `selection_version`.

**API do Dashboard.**
- `GET /api/routing/classifier` → estado atual do projeto do Dashboard: versão, escolha,
  modo, autoria e motivo, as opções com `allowed` e o código de recusa previsto, o `mode` do
  roteamento e as 20 últimas versões.
- `POST /api/routing/classifier` com `{choice, mode?, expected_version, operation_id,
  reason, approver, approver_password}` → `200 {ok, status: "applied" | "already_processed",
  current}`, ou `{ok: false, code, error}` com 400 (pedido inválido), 401/403/429 (aprovador,
  como hoje), 409 (`CLASSIFIER_VERSION_CONFLICT`, `CLASSIFIER_IDEMPOTENCY_MISMATCH`) ou 422
  (`CLASSIFIER_SCOPE_NOT_AUTHORIZED`, `CLASSIFIER_NOT_CALIBRATED`,
  `CLASSIFIER_LOCKED_BY_EXPERIMENT`).

## Critérios de aceite

- **AC-01 (inércia):** policy com `provider ∈ {off, cheap_rule}`, ou `jev` sem
  Authority Ref válida, ou `mode` OFF → nenhuma conexão aberta (o fake não recebe
  nada), nenhum Attempt `classifier`, argv e RoutingDecision iguais a `4d39a3c`.
- **AC-02 (sem efeito no despacho):** com tudo válido e o fake respondendo C1 com
  confiança 0,99 para um grupo C4, o argv, `class`, `selection_source` e `chosen`
  são idênticos aos sem núcleo 2; só `nucleus2` e `classifier_ref` mudam.
- **AC-03 (zona cinzenta):** uma tabela de casos derivada do §4.5 e de B3 (≥ 12
  casos), cada um com "chama / não chama" e o motivo; exclusões soberanas nunca
  chamam.
- **AC-03b (sonda C1–C3):** grupos C1, C2 e C3 sem exclusão chamam o Jev com
  `probe = UPGRADE_PROBE`. Uma resposta maior (por exemplo, C4 com confiança 0,5)
  grava `would_class = C4`; uma resposta menor grava `DOWN_IGNORED`. O despacho
  continua no Sonnet ou no Opus como o núcleo 1 decidiu (igualdade do AC-02).
- **AC-04 (envelope):** o corpo recebido pelo fake contém só os três campos;
  nenhum contém conteúdo de arquivo, diff, nome de projeto ou id do Redmine.
- **AC-05 (guarda):** cada categoria do B5 tem um caso que bloqueia o envio
  (fake sem requisição) e grava só a categoria; texto limpo passa.
- **AC-06 (segredo):** a chave do fake não aparece em nenhum arquivo gravado
  (Attempt, state, eventos, logs capturados); a config só tem o nome do item.
- **AC-07 (admissão):** cada linha da tabela B2 tem um teste; `active` vira
  `shadow` com `ACTIVE_NOT_CALIBRATED`; nenhum caso bloqueia a admissão.
- **AC-08 (registro):** o Attempt de efeito existe **antes** de o fake receber a
  requisição; fecha `COMPLETE`/`FAILED`/`UNCERTAIN` conforme B7; a EffectId inclui
  `rep_index`.
- **AC-09 (não-repetição):** timeout → `UNCERTAIN` e nenhuma segunda requisição
  na mesma visita nem no retry; retry na mesma visita reusa a opinião `COMPLETE`.
- **AC-10 (401/403):** revoga o efeito e desliga o núcleo 2 no resto da Run; o
  Implement despacha normalmente.
- **AC-11 (nó não bloqueia):** em todos os desfechos do B7 o Attempt do Implement
  continua `STARTED` e o `summarize` não ganha obrigação pendente.
- **AC-12 (`classifier_ref`):** os 8 campos presentes e explícitos, iguais no
  snapshot e em cada Attempt; sem versão reportada, `model_version = UNKNOWN`.
- **AC-13 (U15):** com o fake determinístico, 100% de concordância; com o fake
  alternando, a taxa calculada confere; `--max-calls` respeitado; repetições
  `COMPLETE` não são refeitas.
- **AC-14 (suíte):** a receita oficial (`harness/run-tests.js`) passa em Node 22 e
  24; os consumidores de `listAttempts` (custo por Attempt, Dashboard) ignoram ou
  mostram o nó `classifier` sem quebrar.
- **AC-15 (seletor, opções):** `policy_only` grava `provider = off`; `policy_jev` grava a
  seção completa com os parâmetros da plataforma; sem registro, vale a policy. A p1 e o hash
  dela não mudam.
- **AC-16 (writer, ordem 0–5):** cada recusa da tabela do B11 tem um teste, com o código; a
  idempotência é conferida antes do CAS; `active` é sempre `CLASSIFIER_NOT_CALIBRATED`;
  `policy_jev` sem Authority Ref é `CLASSIFIER_SCOPE_NOT_AUTHORIZED`.
- **AC-17 (auditoria e atomicidade):** cada versão tem autor, data, anterior, novo, motivo,
  `operation_id` e hash do pedido; duas escritas concorrentes com a mesma `expected_version`
  → uma grava e a outra recebe 409.
- **AC-18 (só Runs novas):** trocar a escolha não muda o snapshot nem a decisão de uma Run em
  andamento; a Run seguinte usa a versão nova; o `classifier_ref` traz `selection_version`.
- **AC-19 (API):** `GET` e `POST /api/routing/classifier` com aprovador autenticado, CAS e
  `operation_id`; a recusa sai com o código, nunca 500.

## Conformidade com o DOM-07 (R-4: "a SDD verifica a adequação")

| Precondição F12 §3 | Coberta? |
| -- | -- |
| Intenção durável antes da emissão | sim (B6) |
| Authority Ref ligada ao envelope | sim na forma (B2); **o registro durável não existe** (DP-7) |
| Classificação de dado dentro do teto do destino | **não**: classes e teto são UNKNOWN (U-A4, UNK-SEC-005); usa o limite de conteúdo do R-3 + guarda B5 |
| Claim/fencing atuais | sim (reserva do nó) |
| `OUTCOME_UNKNOWN` sem certeza | sim (`UNCERTAIN`) |
| EffectId determinístico por causa | sim, com `rep_index` |
| Journal único, sem paralelo | reusa o Attempt de efeito; não cria journal |

As duas lacunas ("não" e o registro da ref) voltam à reconciliação do RC-6 (AGENTS.md
regra 8); a fatia não as fecha nem as trata como aprovadas.

## Arquivos previstos (a confirmar no plano)

`scripts/lib/jev-client.js` (novo: requisição, parse, timeout, certeza),
`scripts/lib/classifier-guard.js` (novo: B5), `scripts/lib/classifier-gray-zone.js`
(novo: B3), `scripts/lib/model-routing.js` (opinião na decisão, `classifier_ref`),
`scripts/lib/model-routing-policy.js` (seção `classifier` do jev; credencial no
config do consumidor), `scripts/readmine-watcher.js` (admissão e chamada antes do
`beginAttempt` do Implement), `scripts/jev-calibrate.js` (novo, U15), testes
correspondentes e um fake em `harness/` ou no próprio teste. `dom06-attempt.js`
sem mudança de contrato (só uso).

## Perguntas (registro; todas decididas em 2026-11-06, ver a tabela de decisões)

0. **Q0 — DECIDIDA (Richard, 2026-11-06): (b), com a sonda de subida em sombra
   nos grupos C1–C3 (Q0' aprovada).** O texto abaixo fica como registro da
   pergunta. **Q0 — Subida ativa já ou tudo em sombra?** O §4.8 diz que subir vale
   "sempre" (≥ 0,3), mas as validações 0–5 exigem `calibration_ref` para qualquer
   `jev` em `active`.
   - **(a)** Subida ativa já, sem calibração, porque o erro só custa dinheiro; a
     descida fica em sombra até calibrar. A fatia vira modo misto (ver Objetivo),
     o que contradiz a validação 3 do §4.8. Exige uma decisão sua que relaxe a
     validação 3 só para a subida e volta à reconciliação do RC-6 (regra 8).
   - **(b)** Tudo em sombra até calibrar, como nas validações. É o escopo atual
     deste SPEC.
   - **Achado que pesa na escolha:** pela definição de B3, todo grupo da zona
     cinzenta **já está em C4** (G1 = R3; G2 = R8 ou R4 por `n_files`). Na policy
     p1, C4 e C5 vão ambos para o Opus, e o esforço não é aplicado (SP-1). Então,
     **dentro da zona cinzenta**, subir de C4 para C5 não muda o despacho hoje. A
     subida só melhoraria a qualidade se o Jev também fosse perguntado sobre os
     grupos C1–C3 (os que vão para o Sonnet), o que fica **fora** da zona cinzenta
     do §4.8. Isso amplia o desenho, também volta à reconciliação e aumenta o
     volume de envio (custo do saldo de USD 9 e exposição). Portanto, (a) só tem
     efeito real se vier junto com "perguntar também em C1–C3". Sem isso, (a) e (b)
     dão o mesmo despacho.
   - **Recomendação:** (b) agora, gravando em sombra a opinião de subida também
     nos grupos C1–C3, se você aprovar a ampliação (Q0'), para medir quantas
     subidas teriam acontecido e acertado. A subida ativa fica para uma decisão
     sua com esses dados.
   - **Q0'** (só se fizer sentido para você): perguntar ao Jev também nos grupos
     C1–C3, em sombra. É ampliação do §4.8 e precisa da sua decisão e da
     reconciliação.

1. **Q1 — Onde rodar a sombra.** Só em Runs com `mode = ON` (snapshot e admissão
   já existem; recomendado), ou também nas Runs `OFF` pelo `would_route` da S3
   (mais dado, mas exige classifier na policy de plataforma e outro ponto de
   admissão)? Se o app-back ainda não está com `mode = ON`, a sombra só acumula
   dado depois de ligar o roteamento lá.
2. **Q2 — Nova versão da policy.** Ligar exige `routing-pri205@p2-…` com a seção
   `classifier` do jev (mapeamento de modelos igual à p1). Você aprova uma nova
   versão só para isso, a ser proposta no plano?
3. **Q3 — `rework` exclui da zona cinzenta?** O §4.8 só lista sensível, schema,
   behavior e config. Recomendo excluir também `rework` (R4) e `sensitive_decl =
   UNKNOWN` (por exemplo, AC não achado na spec), o que estreita o G1 do desenho.
4. **Q4 — Revogação da Authority Ref no meio da Run.** Snapshot imutável diz que a
   Run segue com a ref da admissão; revogação, porém, deveria parar o envio já.
   Recomendo: revogação vale a partir do próximo Attempt (único dado relido).
5. **Q5 — Qual enum perguntar.** (a) As classes C1–C5 com critérios em texto
   (recomendado: compara direto com o núcleo 1 e com o desfecho); ou (b) as três
   perguntas do thinkdial (tier `fast/balanced/deep`, esforço 0–3, risco), mapeadas
   para classe depois.
6. **Q6 — Guardar o texto do envelope.** O U15 precisa reenviar a mesma entrada.
   Recomendo guardar o envelope só no diretório da Run do consumidor (fica no
   consumidor, regra 6), com remoção junto da Run; a alternativa é fazer as 5
   chamadas no próprio despacho (5× custo e latência).
7. **Q7 — R-7.** Você aceita o verificador do B5 (categorias acima, bloqueia e não
   redige, sem provar ausência de dado de cliente) como a verificação exigida? Sem
   esse aceite, o núcleo 2 não envia nada.
8. **Q8 — Latência e orçamento.** Com a sonda C1–C3, quase todo grupo sem exclusão
   passa a ser perguntado, então o volume sobe. Timeout de 3 s por chamada e no
   máximo 3 grupos por visita ao Implement (prioridade: G1/G2 primeiro, depois G3)
   estão bons? E um teto de chamadas por dia (saldo de
   USD 9), ou só o `--max-calls` do U15?
9. **Q9 — Authority Ref durável.** Quem registra e onde: o Coordenador no Linear
   (DP-7), com um espelho com hash no consumidor? Até existir, esta fatia pode ir
   para `main` dormente (tudo `AUTHORITY_REF_ABSENT`)? A forma do B2 está correta?
10. **Q10 — Versão do modelo.** Se a TypeSafe só aceita `jev-latest`, a igualdade
    campo a campo da calibração (V7-02) não fica provada. Aceita a sombra com
    `model_version = UNKNOWN` até haver id fixo?

## Premissas (valem se você não corrigir)

- **A1.** A unidade é o grupo do plano (S2/S3) dentro do Attempt do Implement; com
  a S5 a mesma opinião passa a ser por subtarefa, sem mudar o registro.
- **A2.** Um provider (Anthropic) no despacho; o Jev não é provider do Attempt.
- **A3.** Fluxo: Plan → Implement → Review independente (Claude, contexto limpo,
  sem Codex) → Test → Verify → Commit; o merge é só seu.
