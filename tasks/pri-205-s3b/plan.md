# Plano de implementação: PRI-205 S3b, núcleo 2 do Jev em modo sombra

> Deriva do [SPEC.md](../../SPEC.md), aprovado pelo Richard em 2026-11-06. Este
> documento é o **COMO**; em caso de divergência, vale o SPEC. Status: **APROVADO pelo Richard em 2026-11-06** ("Approve, start T1"),
> com as recomendações de P-1 a P-4. As tarefas estão em [todo.md](todo.md).
>
> **Rastreador:** o Linear foi designado (AGENTS.md), mas a issue não existe porque
> o workspace atingiu o limite do plano gratuito. Até ela existir, as tarefas
> ficam em `todo.md`. Este diretório é separado para **não sobrescrever**
> `tasks/plan.md` e `tasks/todo.md` da PRI-233, que ainda têm caixas desmarcadas.
>
> Base: `origin/main` `4d39a3c`. Branch: `spec/pri-205-jev-sombra`.

## Visão geral

O núcleo 2 entra como um **passo assíncrono antes da resolução**: o watcher coleta
as opiniões do Jev para os grupos elegíveis do Implement (G1/G2 primeiro, depois
G3, no máximo 3) e passa o resultado à `resolveRoute`, que continua pura. Cada
chamada é um Attempt de efeito próprio (`node = "classifier"`). A classe, o modelo
escolhido e o argv saem só do núcleo 1; a RoutingDecision ganha `nucleus2` por
grupo e o `classifier_ref` completo. Tudo fica desligado até existirem a Authority
Ref (Q9), a policy p2 (Q2) e o item no Keychain.

## Decisões de arquitetura

- **AD-1. A `resolveRoute` continua pura e síncrona.** As opiniões entram como
  `input.nucleus2` (dado já coletado). A rede fica num módulo próprio
  (`classifier-shadow.js`), chamado com `await` antes da `resolveNodeRoute`, só no
  Implement. Assim, o AC-02 (igualdade com e sem núcleo 2) é um teste puro.
- **AD-2. Um módulo por responsabilidade, todos novos:**
  - `classifier-gray-zone.js`: elegibilidade (B3), pura;
  - `classifier-guard.js`: verificação de conteúdo (B5), pura;
  - `jev-client.js`: requisição, parse e certeza do desfecho (B7), com `fetch` e credencial injetáveis;
  - `classifier-authority.js`: validação da Authority Ref (B2), pura;
  - `classifier-shadow.js`: orquestração, efeito, envelope e não-repetição (B6, B7).
- **AD-3. O registro do efeito reusa `dom06-attempt`** (`beginAttempt`,
  `authorizeEffect`, `recordEffect`, `closeAttempt`) no padrão do `db-effect.js`.
  O contrato do DOM-06 não muda.
- **AD-4. Credencial.** O provider de produção lê o Keychain por
  `/usr/bin/security find-generic-password -s prisma-jev-typesafe -a typesafe -w`
  (`execFile`, sem shell), sem prompt interativo. O valor só existe em memória
  durante a chamada. Os testes injetam um provider falso.
- **AD-5. Destino fixo.** A URL é uma constante do `jev-client`. Os testes passam a
  base por parâmetro da função, nunca por env nem por config.
- **AD-6. Desligamento da Run após 401/403:** um marcador em
  `<run>/dom06/classifier-disabled.json`, gravado uma vez, não no `state.json`.
  Isso evita disputar o escritor do state.
- **AD-7. O envelope (Q6)** fica em `<run>/dom06/classifier/envelopes/<sha256>.json`,
  só no consumidor, e sai junto com a Run. A telemetria e o Attempt guardam só o hash.
- **AD-8. Authority Ref (Q9).** O consumidor guarda o espelho em
  `.claude/classifier-authority.json`, com `sha256`; a config de roteamento aponta
  para ele por `authority_ref {id, sha256, path}`, como o `policy_ref`. A admissão
  valida e grava `classifier_effective` no snapshot. A revogação é relida a cada
  Attempt (Q4): só o campo `revoked_at` do espelho, com o hash conferido.
- **AD-9. ~~Policy p2 (Q2).~~ Substituída pela Q12 (2026-11-06):** os parâmetros do Jev vêm da plataforma e ficam no registro de seleção; a p1 fica como está. Texto anterior: O plano gera a **proposta**
  `routing-pri205@p2-<data>` em `prisma-evidence/`, com o mapeamento igual ao da
  p1 e a seção `classifier` do jev. Ela não vai para o consumidor sem a sua
  aprovação.

## Lista de tarefas

### Fase 1: peças puras e o cliente (o maior risco primeiro)
- [x] T1: zona cinzenta e sonda C1–C3 (`classifier-gray-zone.js`)
- [x] T2: verificador de conteúdo (`classifier-guard.js`)
- [x] T3: cliente do Jev com o fake HTTP (`jev-client.js`)

### Checkpoint A
- [x] Testes focados passam sob `loopback-only`, e o fake nunca recebe a chave em claro fora do header

### Fase 2: config, autoridade e efeito
- [x] T4: seção `classifier` do jev na policy roteada e `classifier_credential` no config
- [x] T5: Authority Ref e `classifier_effective` na admissão
- [x] T6: orquestração em sombra com Attempt de efeito (`classifier-shadow.js`)

### Checkpoint B
- [x] Suíte `scripts` inteira passa; AC-07 a AC-11 automatizados (Node 22: 1470/0; Node 24: 1470/1, só a limpeza preexistente do golden, que passa sozinha)

### Fase 3: integração, U15 e fechamento
- [x] T7: `nucleus2` e `classifier_ref` na RoutingDecision, com a ligação no watcher
- [x] T8: comando U15 `jev-calibrate.js`
- [x] T9: consumidores dos Attempts e documentação do consumidor (p2 dispensada pela Q12)

### Fase 4: seletor "Só policy" × "Policy + Jev" (R-SEL, SPEC §B11; Q11–Q14)
- [x] T10: registro de seleção e writer governado (`classifier-selection.js`)
- [x] T11: admissão lê o registro (snapshot `classifier_selection_ref`, `selection_version` no `classifier_ref`)
- [x] T12: `GET`/`POST /api/routing/classifier` no Dashboard (exceção explícita na lista de violações conhecidas, decisão do Richard; CAS em `scripts/cas.js`); contrato enviado à sessão `routing-screens`

### Checkpoint C (fechamento)
- [ ] Receita oficial em Node 22 e 24, mais `check:js`, `lint:src` e `arch:check`
- [ ] Revisão independente G2 (Claude Opus, contexto limpo, sem Codex) com os achados resolvidos
- [ ] Verify por AC (`tasks/pri-205-s3b/evidence.md`), handoff, commit; PR em draft; o merge é seu

## Riscos e mitigações

| Risco | Impacto | Mitigação |
| -- | -- | -- |
| Formato da API TypeSafe conhecido só pelo plugin thinkdial | Alto | T3 isola o formato num só módulo; resposta fora do enum vira `OUT_OF_ENUM`; a primeira chamada real é manual (P-3), não em despacho |
| `resolveNodeRoute` é síncrona e é chamada em dois lugares (`:4459`, `:4816`) | Médio | AD-1: só o caminho do Implement (`:4816`) ganha o `await` anterior; `fetch_ticket` e Plan não mudam |
| Keychain pede diálogo num watcher sem ninguém olhando | Médio | O comando não é interativo; falha vira `CREDENTIAL_UNAVAILABLE` (certa, sem envio); a documentação diz como dar acesso ao `/usr/bin/security` |
| O Attempt `classifier` aparece onde se leem Attempts (`cost-projection.js:37`, `routing-run.js:102`) | Baixo | T9 testa os dois; o `latestBound` filtra por nó |
| Latência no despacho do Implement (até 3 × 3 s) | Médio | Teto do Q8; latência gravada por chamada para medir |
| Saldo de USD 9 gasto mais rápido com a sonda C1–C3 | Baixo | Sem teto (Q8); o gasto aparece no saldo; esgotado = `FAILED`, sem repetição |
| `memory/routing/` do consumidor ser versionado no git (o registro deve ficar fora do git, Q11) | Médio | T10 confere o `.gitignore` do consumidor sem ler dados; a documentação (T9) diz para ignorar `memory/routing/`; o writer não depende do git |
| Ampliação do §4.8 (sonda C1–C3) sem reconciliação | Médio | Registrada no SPEC e no handoff como candidata da reconciliação do RC-6 (regra 8); não aplicada |

## Perguntas em aberto (do plano)

- **P-1. Estimativa:** 5 pontos (faixa de 3 a 8). Não há base empírica para chamada externa.
- **P-2. Uma fatia ou duas?** Recomendo um PR único, com checkpoints. A alternativa
  é separar T8 (U15) num segundo PR.
- **P-3. Primeira chamada real.** Recomendo um teste de fumaça manual, seu, com um
  envelope sintético (`jev-calibrate --synthetic --max-calls 1`) antes de ligar a
  p2 no consumidor. É a primeira prova do formato real da API.
- **P-4. Ordem de ativação** depois do merge: (1) o Coordenador registra a Authority
  Ref; (2) você aprova a p2; (3) você cria o item no Keychain; (4) o consumidor
  recebe a p2 e o espelho. Sem as quatro etapas, a fatia fica dormente.
