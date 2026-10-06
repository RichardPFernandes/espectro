---
description: Nó "Verify" — checklist de aceite final antes do commit.
---
> Consumo externo da candidata PRI-60: `PRISMA_ROOT` aponta ao checkout fixado da
> plataforma; cwd/`REPO_PATH` e `memory/` pertencem ao consumidor/worktree.
> Referências a `scripts/`, `templates/`, `.graph/schemas/` e a este template são
> assets da plataforma, resolvidos por `PRISMA_ROOT`; configuração, spec e registros
> históricos continuam no consumidor. Não copiar/reatar estado para corrigir paths.
> Regras, toolchain e repositórios relacionados vêm de `memory/project.yaml` e da
> configuração explícita do consumidor. Exemplos históricos não definem defaults.


Task-id: $ARGUMENTS

Você está executando o nó **Verify**.

O Verify valida os **Critérios de Aceite definidos na Spec e referenciados pelo
Plan** — nunca a interpretação deles no handoff/context. Em divergência, a **spec
vence**, salvo SPEC_CHANGE explicitamente aprovado (`spec_change_approved: true` +
`spec_change_hash` = hash atual da spec, gravados por humano no state.json).

0. **Portão de drift da spec**:
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" check memory/runs/$ARGUMENTS --node=verify --write`.
   Exit 3 = spec mudou depois do Plan sem SPEC_CHANGE aprovado (`status="spec-drift"`
   já gravado): **pare**, sem veredito e sem mexer em `node`/`retries`.
0b. **Validade da evidence** (Dependency Invalidation — `docs/dependency-invalidation.md`):
   `node "$PRISMA_ROOT/scripts/invalidate.js" guard memory/runs/$ARGUMENTS --phase=verify`.
   O script lê `state.json.artifact_validity.evidence`, o `spec_hash` da matriz e o
   journal de transições pendentes do run — você **não** compara hash nenhum. Exit 1 =
   evidence recusada: `PENDING_SPEC_INVALIDATION` (SPEC_CHANGE aprovada ainda não
   aplicada a este run — fail-closed), `EVIDENCE_SPEC_STALE` ("Evidence produzida contra
   Spec vN, Spec atual é vM. Execute novo ciclo.") ou `EVIDENCE_SPEC_UNKNOWN` (legado sem
   versão: UNKNOWN não é FAIL de teste, mas evidence UNKNOWN não comprova a spec atual).
   Evidence STALE/UNKNOWN **nunca** vale como VALID: o Verify reprova (o passo 1 registra o mesmo `[FAIL]`); não edite
   `validity` nem `spec_hash` à mão — só um `/test` novo (finalize) produz evidence VALID.
1. **Conformidade Spec → Plan → Handoff → Evidência** (determinística):
   `node "$PRISMA_ROOT/scripts/lib/spec-authority.js" verify memory/runs/$ARGUMENTS --write`
   (grava `spec-conformance.md` no run, `state.json.spec_conformance` — com
   `acceptance` = métricas da matriz e veredito conferido por AC — e o bloco
   `verification` em `acceptance-evidence.json`, todos com `spec_version`/`spec_hash`
   verificados). Exit 1 = **Verify falha**, com o motivo de cada `[FAIL]`:
   - `SPEC_DRIFT` — spec diferente da lida pelo Plan, sem aprovação válida;
   - **Versão da spec** (run versionado — `docs/spec-versioning.md`): artefato
     (Plan/Review/Test) registrado sobre outra `spec_version`/`spec_hash` que a vigente
     = `[WARN] SPEC_CHANGE_MID_RUN` (chega ao relatório e à descrição do PR; regere o
     artefato se a mudança for de contrato); `SPEC_VERSION_MISMATCH` (mesmo hash com
     versão diferente — state inconsistente) e `EVIDENCE_SPEC_VERSION_MISMATCH` (matriz
     de outra versão) reprovam. Run legado: nada disso se aplica;
   - **Matriz de cobertura** (`acceptance-evidence.json`, escrita pelo /test — o
     Verify confere os artefatos, nunca só o `result` relatado):
     - `EVIDENCE_MISSING` / `EVIDENCE_INVALID` / `EVIDENCE_DUPLICATE_AC` — matriz
       ausente, fora do schema (`.graph/schemas/acceptance-evidence.schema.json`) ou
       com o mesmo AC repetido;
     - `AC_WITHOUT_EVIDENCE` — AC ativo da spec fora da matriz;
       `EVIDENCE_SPEC_STALE` — matriz gerada sobre outra versão da spec, ou invalidada
       por SPEC_CHANGE aprovada (AC novo depois do Test cai aqui);
       `EVIDENCE_SPEC_UNKNOWN` — matriz (ou `ac-evidence.md`) sem `spec_hash`: legado
       sem versão, não comprova a spec atual;
     - `ARTIFACT_MISSING` / `ARTIFACT_NOT_FOUND` — evidência sem `artifact`, ou
       apontando arquivo/linha que não existe;
     - `TEST_NOT_EXECUTED` / `TEST_NOT_IDENTIFIED` / `TEST_SKIPPED` — o teste alegado
       não está no relatório surefire/log, não dá pra saber qual é, ou foi ignorado;
     - `RESULT_MISMATCH` — `result` diferente do que o relatório/log registra;
     - `AC_EVIDENCE_FAIL` (FAIL propagado), `AC_BLOCKED`, `AC_STATUS_INCONSISTENT`
       (status ≠ agregado das evidências), `AC_ONLY_NOT_APPLICABLE`,
       `AC_NOT_AUTOMATED_WITHOUT_JUSTIFICATION` / `EVIDENCE_WITHOUT_JUSTIFICATION`.
     - `NOT_AUTOMATED` **com** justificativa **não reprova**: sai como
       `[WARN] AC_NOT_AUTOMATED` e na seção "Validação humana pendente" do
       `spec-conformance.md` — leve-a para o `context.md` e para a descrição do PR
       (via handoff do `/commit`), nunca a omita.
     - Run iniciado antes de 2026-10-01 sem matriz: o `ac-evidence.md` antigo é
       evidence UNKNOWN (sem identidade de spec). UNKNOWN não é FAIL de teste, mas não
       comprova a spec atual — o Verify é fail-closed e reprova com
       `EVIDENCE_SPEC_UNKNOWN` (+ `[WARN] LEGACY_AC_EVIDENCE_MD`); rode o `/test` para
       gravar a matriz.
   - `PLAN_OMITS_AC` / `PLAN_UNKNOWN_AC` / `PLAN_AC_TEXT_DIVERGES` — o Plan omitiu
     AC, citou AC que a spec não tem ou reescreveu um critério;
   - `HANDOFF_*` — handoff diverge da spec (referência de spec errada/ausente, lista
     `ACs:` diferente dos IDs ativos, texto de AC reescrito);
   - `BEHAVIOR_CHANGE_WITHOUT_APPROVAL` — decisão de implementação desta task muda
     comportamento de um AC sem SPEC_CHANGE aprovado.
   `[WARN]` não reprova (ex.: cópia literal de AC no handoff, baseline tardio).
   Do Review (`state.json.review_results`, ver `.claude/commands/review.md`), chegam
   aqui como aviso: `REVIEW_SPEC_CLARIFICATION` (spec ambígua; o código explicitou um
   comportamento compatível — confirme no passo 2 que o teste cobre o comportamento
   escolhido e leve cada um para o `context.md` e a descrição do PR, como os
   `NOT_AUTOMATED`), `REVIEW_TECHNICAL_DECISION` (decisão técnica registrada, sem
   efeito funcional), `REVIEW_SPEC_HASH_STALE` / `REVIEW_SPEC_UNKNOWN` (o Review avaliou
   outra versão da spec / é legado sem versão), `REVIEW_COMPLIANCE_NOT_VALID` (o Review
   avaliou um implement STALE/UNKNOWN — leve para o `context.md` e o PR) e `REVIEW_NOT_PASSED` (a task chegou aqui com o último Review reprovado —
   confira os achados de `review-result.md` antes de aprovar).
   Veredito `N/A` = task sem spec (ad-hoc): siga com os passos 2–3.
2. **Evidência real**: o passo 1 já provou que cada artefato existe e registra o
   resultado alegado. Aqui, o que o script não vê: rode de novo os testes citados na
   matriz (`node "$PRISMA_ROOT/scripts/lib/acceptance-evidence.js" trace memory/runs/$ARGUMENTS AC-NN`
   mostra a cadeia SPEC → PLAN → IMPLEMENTATION → TEST de cada AC) e confirme que o
   teste exercita o comportamento **descrito na spec** (texto em `## Critérios de
   Aceite`), não uma versão reinterpretada — teste verde que não testa o AC é
   `AC_EVIDENCE_FAIL` manual: volte pro `test`. Registre no
   `context.md` o resultado por ID (`AC-01: ok — <evidência>`,
   `AC-03: NOT_AUTOMATED — <justificativa>`), mais qualquer
   critério padrão do projeto em `memory/project.yaml` — hoje o arquivo não tem
   seção de critério padrão; não o abra inteiro por isso: as regras invioláveis
   são lidas no passo 4, e um `grep -n -i 'criterio\|critério' memory/project.yaml` basta pra
   confirmar se alguma seção nova surgiu.
3. Confirme que nada ficou fora do escopo original sem sinalização.
4. **Classificação de risco do PR** (histórico em
   `memory/decisions/2026-09-22-pr-draft-high-risk.md`, que não existe nesta
   `memory/` — os critérios abaixo são autocontidos, não tente abri-lo). Não bloqueia nada — só
   decide como o `/commit` abre o PR (Draft + `[HIGH-RISK]` ou normal). Releia
   `memory/project.yaml > regras_invioláveis` antes de classificar (só essa seção:
   `sed -n '/^regras_invioláveis:/,/^[a-z_]*:$/p' memory/project.yaml`), e baseie-se
   no `git diff` real lido nesta sessão (`git diff <base>...HEAD --name-only` +
   working tree), de **todos** os repos tocados pela task (app-back e worktrees
   irmãos de app-core/mo-entity/app-front). Classifique como `high-risk` se
   qualquer critério abaixo for verdadeiro:
   - Regra/dominio legado crítico identificado nas regras invioláveis do consumidor.
+   - Mudança de schema/dados ou isolamento, conforme stack e contratos do consumidor.
+   - Autenticação/autorização/segurança, conforme agentes_por_dominio do consumidor.
+   - Mudança ampla cujo risco está definido no contexto do consumidor.
+
+   Caso contrário, `low-risk`. Grave em `state.json`:
   - `risk_level`: `"high"` ou `"low"`
   - `risk_reason`: frase curta com o(s) critério(s) atingido(s) e o arquivo que
     disparou (ex: `"Motor de frete legado: track/calculofrete/GrupoDTO.java"`),
     ou `"Nenhum critério de alto risco identificado"`.

   Grave os dois campos mesmo quando o Verify **falhar** — se o loop voltar pra
   `test`/`implement`, o próximo Verify reclassifica sobre o diff novo.

## Aresta condicional
Transição sempre pela CLI: `node "$PRISMA_ROOT/scripts/state-writer.js" transition memory/runs/<task-id>
--from=verify --to=<nó> [--retry]` (`--retry` incrementa `retries.verify`, com CAS —
`docs/concurrency-map.md`). Exit 3 = `STATE_CONFLICT`/`SESSION_CONFLICT` (o run mudou ou outra sessão assumiu — a CLI já re-tentou uma vez quando fazia sentido): pare sem gravar mais nada e reporte.
- **Passou** → `--to=commit`, rode `/commit $ARGUMENTS`.
- **Falhou** → `--to=test` (matriz ausente/obsoleta, artefato que não
  confere, AC sem cobertura) ou
  `"implement"` (escopo, comportamento divergente da spec, handoff divergente, ou
  `PLAN_*` — o Implement, pela regra "escopo do Plan errado", devolve pro /plan;
  `AC_EVIDENCE_FAIL` com teste correto e código errado), `AC_BLOCKED` por dependência
  externa → escale pro humano (retry não destrava),
  com `--retry` (incrementa `retries.verify`), registre o motivo (os `[FAIL]` do passo 1), rode o
  comando correspondente de novo. `SPEC_DRIFT` não é retry: o passo 0 já pausou.

## Limite de loop
Se `retries.verify >= 2`, pare e escale pro humano.
