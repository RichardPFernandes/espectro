# Maestri — Agent Handoff Contract v1.1

## Objetivo

Padronizar a transferência de trabalho entre agentes, reduzindo consumo de contexto, retrabalho e perda de informações.

## Escopo

Este contrato rege a transferência entre agentes coordenados pelo Maestri
(coordenador, arquiteto, implementador, revisor, QA etc.). Ele não substitui o
`memory/runs/<task-id>/handoff.md` dos nós do grafo (`.claude/commands/*.md`),
que continua sendo o estado operacional de cada run com o formato definido em
`.claude/commands/plan.md`. Quando um agente executa nós do grafo, o handoff deste
contrato referencia aquele arquivo em `context_refs` em vez de reproduzi-lo.

Template: [templates/handoff.yaml.template](../templates/handoff.yaml.template).
Validador: `node scripts/validate-handoff.js <handoff.yaml|handoff.md> [--check-paths] [--pre-done] [--task-type <tipo da tabela>]`.

### Regras obrigatórias

1. Todo agente deve produzir um handoff ao concluir, bloquear ou interromper uma tarefa.
2. O handoff deve conter fatos verificáveis, não apenas afirmações de sucesso.
3. Referenciar artefatos existentes em vez de reproduzir documentos completos.
4. Separar decisões aprovadas de recomendações e hipóteses.
5. Não transformar conclusões de agentes em autoridade sobre especificações.
6. Preservar IDs do Linear, critérios de aceite, decisões e referências de evidências.
7. Nunca declarar testes como aprovados sem execução comprovada.
8. Não modificar requisitos ou decisões aprovadas sem autorização.
9. O agente receptor deve validar as pré-condições antes de prosseguir.
10. O handoff é YAML: arquivo `.yaml` ou um bloco ```` ```yaml ```` dentro de um `.md`. Prosa sem esse bloco não atende o contrato.

## Estrutura obrigatória

```yaml
handoff_version: "1.0"

task:
  id: "PRI-XXX"
  objective: "Objetivo da tarefa"
  specification_ref: "Referência da especificação"

execution:
  agent: "implementer"
  status: "COMPLETED"
  summary: "Resultado objetivo"
  branch: "feature/example"
  commit: null

artifacts:
  - path: "src/example.ts"
    action: "MODIFIED"
    description: "Alteração realizada"

decisions:
  approved: []
  proposed: []

validation:
  executed:
    - command: "npm test"
      result: "PASSED"
      evidence: "Referência ao log"
  not_executed: []

open_issues: []

next:
  recommended_agent: "reviewer"
  action: "Revisar implementação"
  prerequisites: []

context_refs: []
```

## Versão 1.1 (aditiva)

A 1.1 só acrescenta campos; todo handoff 1.0 válido continua válido como 1.0.
Com `handoff_version: "1.1"`, `routing` e `risk` passam a ser obrigatórios.

```yaml
handoff_version: "1.1"

task:
  acceptance_criteria: []      # IDs ou textos dos ACs da spec/issue (não reescrever)

routing:                       # obrigatório na 1.1
  from: "Implementador"        # agente que entrega
  to: "Revisor"                # agente que recebe
  runtime: "claude"            # claude | codex | human | other — runtime de quem executou
  fallback_reason: null        # preenchido quando a tarefa trocou de runtime

risk:                          # obrigatório na 1.1
  level: "MEDIUM"              # LOW | MEDIUM | HIGH | MAX
  signals: []                  # obrigatório em HIGH/MAX: o que motivou (ex.: migração, auth)
  classified_by: "Coordenador"

facts: []                      # constatações com evidência
assumptions: []                # hipóteses — nunca tratadas como fato pelo receptor

usage:                         # só valores observados; o que não foi medido é UNKNOWN
  duration: "UNKNOWN"
  retries: 0
  tokens: "UNKNOWN"
```

Em `validation.executed`, o campo opcional `expected` (`PASSED` padrão, ou `FAILED`)
declara o resultado esperado. Teste de injeção de falha — rodado contra código
sabotado para provar que o teste detecta o defeito — usa `expected: "FAILED"`.
Só conta como falha o item cujo `result` difere de `expected`.

## Validação

O receptor roda `node scripts/validate-handoff.js` antes de aceitar o handoff:

- `ERROR` impede a aceitação: campo obrigatório ausente, status fora do enum,
  resultado sem evidência, `COMPLETED` com falha inesperada não explicada em
  `open_issues`, `NEEDS_HUMAN`/`BLOCKED` sem `open_issues`, credencial no arquivo,
  `usage` com valor estimado.
- `WARN` é conferido e registrado, sem bloquear.
- O validador confere forma e coerência, não verdade: não reexecuta testes. Com
  `--check-paths`, confere que artefatos e evidências citados existem.
- `--pre-done` é outra invocação (checagem pré-Done, abaixo). Sem essa flag, o
  resultado da aceitação permanece o mesmo.

## Estados permitidos

- COMPLETED: etapa concluída com evidências.
- BLOCKED: impedimento técnico ou operacional.
- NEEDS_HUMAN: decisão humana necessária.
- FAILED: etapa não concluída.
- PARTIAL: resultado parcial aproveitável.

## Encerramento por tipo de tarefa

`COMPLETED` conclui a etapa do agente; não encerra automaticamente a issue no
Linear. `Done` registra o encerramento da issue no escopo aprovado, não prova
implementação, validação ou promoção fora desse escopo. O coordenador confere
evidências e registra as transições, sem substituir a decisão humana.

| Tipo de tarefa | Evidências mínimas para Done | Quem confirma |
| -- | -- | -- |
| Planejamento/documental — planejamento Prisma | Approved Document + Evidence + Handoff FINAL + Planning Ledger atualizado; após a confirmação, issue em Done. Preservar os gates aplicáveis à baseline da tarefa. | Richard confirma a aprovação humana; o coordenador confere a persistência das evidências e registra a transição. |
| Planejamento/documental — demais entregas documentais | Handoff FINAL com fatos verificáveis e referências aos artefatos, conforme este contrato, e evidência persistida (abaixo). Critérios adicionais por perfil: G0 — só a confirmação do perfil; G1 — aceite do owner registrado na issue; G2 — G1 + duplicações e impactos explicitados no Handoff FINAL; G3 — G2 + candidato de reconciliação registrado, sem alterar o Roadmap, e revisão Claude **e** Codex. | Revisor confirma o perfil (abaixo); o coordenador confere o handoff e a persistência das evidências (`--pre-done`: exit 3); Richard confirma o Done com aceite explícito. |
| Implementação (feature/refactor) | Handoff com artefatos, revisão independente, testes/Verify aplicáveis e evidências atribuíveis à versão, conforme o ciclo vigente; estado de cada AC pela regra por AC (abaixo). Critérios adicionais por perfil: G0 — testes existentes executados; G1 — G0 + cada AC ativo verificado ou com exceção humana própria, aceite dos ACs pelo owner e spec/RN só se pertinente; G2 — G1 + achados da revisão de outro runtime resolvidos, delta por capability atualizado como `Candidate` e aprovação do Richard; `INC`/Decision, quando não houver, declarado "N/A — operação protegida não liberada", o que não autoriza incorporação nem torna o `Candidate` vigente; G3 — G2 + revisão Claude **e** Codex, `risk.level` HIGH/MAX com `signals` e PR Draft. Relação entre merge e encerramento: a definir pelo Richard. | Revisor/QA confirmam somente os resultados técnicos do seu escopo e o perfil (abaixo); o coordenador confere (`--pre-done`: exit 3); Richard confirma o Done. Merge exclusivo do Richard. |
| Correção de bug | Handoff com evidências exigidas pelos critérios de aceite da issue, revisão independente e testes/Verify aplicáveis, atribuíveis à versão. Não presumir reprodução, cobertura ou teste não executado. Estado de cada AC pela regra por AC (abaixo). Critérios adicionais por perfil: os mesmos de Implementação (feature/refactor). | Revisor/QA confirmam somente os resultados técnicos do seu escopo e o perfil (abaixo); o coordenador confere (`--pre-done`: exit 3); Richard confirma o Done. Merge exclusivo do Richard. |
| Investigação/discovery (só leitura) | Handoff com fontes/versões, escopo observado, resultados e limites verificáveis; distinguir fatos, hipóteses e UNKNOWN. Critérios adicionais por perfil: G0 — fatos, hipóteses e UNKNOWN separados, e executado separado de não executado (`not_executed`); G1 — G0 + recibos de leitura das fontes; G2/G3 — G1 + revisão independente da auditoria por outro runtime antes de ela virar insumo de decisão. | Revisor confirma o perfil (abaixo); o coordenador confere o handoff, inclusive a presença de `not_executed` e as separações (`--pre-done`: exit 3); Richard confirma o Done. |
| Revisão/QA | Handoff com escopo/versão revisados, achados e evidências das verificações efetivamente executadas, separadas das não executadas. Critérios adicionais por perfil: os mesmos de Investigação/discovery. QA de uma implementação ainda não aceita herda o perfil dela. | Revisor/QA confirmam o resultado técnico da própria etapa e o perfil (abaixo); o coordenador confere (`--pre-done`: exit 3); Richard confirma o Done. |

Os critérios adicionais por perfil usam o perfil G0–G3 (DS-06) declarado no Ready
com o sinal, conforme a
[política Work Type](https://linear.app/prisma-app/document/prisma-politica-de-classificacao-e-modelos-de-issue-work-type-cycle-e033efdc5090),
que também traz o Ready por tipo e perfil. Done = linha da tabela para o tipo +
critérios adicionais acumulados de G0 até o perfil da issue + confirmação do
perfil. "G<n> +" soma os critérios de G<n>, nunca o sinal que classifica G<n>.
O perfil só acrescenta: não dispensa nada da linha, e a linha de planejamento
Prisma vale inteira em qualquer perfil. No handoff, o primeiro item de
`risk.signals` é `G<n>: <sinal>`; o validador não confere esse texto. Ambíguo
sobe; ninguém rebaixa o perfil sozinho.

**Linha de encerramento.** Cada issue do Prisma cai em exatamente uma linha,
registrada no Ready como
`Encerramento: :14x — Work Type <X>; T142 = sim/não, porque <artefato ou "nenhum da lista">`.
O coordenador classifica; o revisor confirma ou sobe.

- Teste T142, com lista fechada: a entrega cria ou altera (1) o Planning Ledger
  da trilha, (2) o plano da trilha registrado como Document da trilha, (3) um
  Approved Document da trilha ou (4) uma baseline de planejamento (Roadmap,
  Freeze, matriz de disposições ou reconciliation candidate). Documento de
  processo da plataforma (este contrato, comandos, política Work Type) não entra
  na lista.
- No Ready, o T142 é decidido pela intenção de produzir ou aprovar um Document
  da trilha. A citação efetiva e o Planning Ledger atualizado são provas do Done
  na linha de planejamento Prisma, não condição do T142.
- Planning cai sempre em planejamento Prisma. Architecture e Governance caem em
  planejamento Prisma se T142 = sim; senão, em demais entregas documentais.
  Implementation, Audit e Validation caem nas linhas próprias; T142 = sim nelas
  significa classificação errada: a parte de planejamento vira issue Planning
  própria, ou o Work Type sobe.
- Quando tipo e produto apontam linhas diferentes, vale a mais exigente. A
  classificação só sobe, inclusive na reavaliação antes do Done se o produto
  mudar.
- Falta de Planning Ledger citável nunca reclassifica: impede o Done da issue
  classificada em planejamento Prisma. Nas demais linhas, o `--pre-done` dá
  exit 3 e a conferência é manual (coordenador e Richard).

**Confirmação do perfil e pertinência.** O handoff de revisão, nos dois canais
(handoff do revisor no Maestri; registro do `/review` no grafo), traz duas
linhas do revisor, nas três famílias, inclusive no documental G0:

- perfil: em G0, "sem mudança de comportamento" (implementação), "sem mudança
  de regra, decisão, escopo ou critério" (planejamento) ou "só leitura, sem
  decisão derivada" (auditoria); em G1–G3, o sinal do perfil, como
  `G2: altera <RN/contrato/schema>`, nunca "sem mudança". Se o sinal não se
  sustenta, o revisor sobe o perfil e não confirma;
- pertinência de spec/RN/ADR: sim ou não, com o motivo. Só é pertinente quando
  a mudança altera requisito, RN, contrato ou decisão de arquitetura.

Em G0 isso não cria arquivo nem aprovação humana adicional.

**Estado de AC (implementação e bug).** A regra é por AC, sem enum novo: valem
os resultados do schema de evidência (`.graph/schemas/acceptance-evidence.schema.json`)
e do `/verify` (`.claude/commands/verify.md`). Conta para o Done só o AC
verificado (PASS automatizado sem WARN para ele, sob Verify PASS da versão
vigente; ou evidência conferida pelo revisor de outro runtime, no interativo) ou
com exceção humana própria (ID do AC, motivo, alcance, aprovador e link). Verify
PASS não promove `NOT_AUTOMATED` com "Validação humana pendente": a prova manual
exige registro (quem, quando, versão, resultado, link). `BLOCKED` por ambiente
é inconclusivo, não falha de código, e não contorna `AC_BLOCKED`; a exceção
também não contorna o gate que reprovou.

A aprovação técnica de Revisor/QA não substitui a decisão humana. Não inferir
autorização de merge nem encerramento da issue a partir de parecer técnico,
validação formal do YAML ou status `COMPLETED`. Merge é exclusivo do Richard.

As evidências citadas no Linear ficam em
`~/Workspace/prisma-evidence/<data>-<frente>/`, não em `/tmp` ou `/private/tmp`.
Um handoff temporário de transferência entre agentes não substitui a persistência
da evidência citada no Linear nem, no planejamento Prisma, o Handoff FINAL e o
Planning Ledger atualizado.

`UNKNOWN` não bloqueia por si só e não vira aprovação, sucesso ou zero. Uma prova
necessária ausente impede apenas a operação que dela depende; não cria bloqueio
global para trabalho independente. Preservar os UNKNOWNs e os gates aplicáveis,
sem resolver omissões por inferência: onde a regra não estiver definida, o
critério é "a definir pelo Richard".

Base: [F31 — Approved Document FINAL](https://linear.app/prisma-app/document/f31-approved-document-final-planning-development-handoff-9d557a552a9a),
[Planning Ledger — Human Interaction](https://linear.app/prisma-app/document/planning-ledger-human-interaction-4c93d6f8be2d),
[baseline arquitetural](prisma/architecture-baseline.md) e
[condições e resíduos por atividade](prisma/residual-gates.md).
A custódia das evidências segue a aprovação do Richard de 2026-10-12
(fila de governança, GOV-3, item 3); a exclusividade de merge, a regra aprovada
em 2026-10-09.
A aceitação do handoff não ganha campo obrigatório: sem `--pre-done`, o validador
ignora `closure`. A checagem pré-Done é invocação separada.

## Checagem pré-Done (maestro-guard)

Antes de uma issue ir para Done, o coordenador roda:

`node scripts/validate-handoff.js <handoff.yaml|handoff.md> --pre-done [--task-type <tipo da tabela>]`

A checagem lê as citações do handoff. Não chama o Linear, não muda status e não
registra Done. Exit 0 significa que as quatro citações do planejamento Prisma
estão presentes e persistidas na forma exigida. A confirmação do Richard
continua obrigatória. Exit 1 recusa essa linha. Exit 3 deixa o Done com o
Richard porque o tipo não tem critério automático.

O bloco `closure` é opcional na aceitação (1.0 e 1.1). `closure.task_type` usa o
texto exato da tabela acima. Sem tipo no bloco e sem `--task-type`, a checagem
não infere. Se os dois vierem preenchidos e divergirem, ela recusa em vez de
escolher.

| `task_type` | O que a checagem faz |
| -- | -- |
| Planejamento/documental — planejamento Prisma | Recusa quando falta Approved Document, Evidence, Handoff FINAL ou Planning Ledger; quando o valor é `UNKNOWN`; quando o caminho está em `/tmp` ou `/private/tmp`; quando Evidence não é o diretório existente `~/Workspace/prisma-evidence/<data>-<frente>/`; quando um arquivo local citado está fora desse diretório; quando o Handoff FINAL é o próprio handoff temporário de transferência. |
| Demais tipos da tabela | Não aplica critério automático (exit 3); os critérios adicionais por perfil da tabela são conferidos manualmente. |

`<data>` é uma data de calendário `AAAA-MM-DD`. `<frente>` é o sufixo do diretório,
como em `2026-10-12-gov-3`. URL de documento é `https://linear.app/<caminho>`; a
checagem não abre essa URL. Evidence é diretório local, não URL. A citação do
Planning Ledger não prova que o ledger foi atualizado. Gates da baseline ficam
fora desta checagem.

```yaml
closure:
  task_type: "Planejamento/documental — planejamento Prisma"
  approved_document: "https://linear.app/prisma-app/document/..."
  evidence: "~/Workspace/prisma-evidence/2026-10-14-frente/"
  handoff_final: "~/Workspace/prisma-evidence/2026-10-14-frente/handoff-final.md"
  planning_ledger: "https://linear.app/prisma-app/document/..."
```

## Responsabilidades do coordenador

- Validar a estrutura recebida.
- Conferir evidências e pré-condições.
- Selecionar o próximo agente.
- Encaminhar somente o contexto necessário.
- Impedir execução quando houver bloqueios obrigatórios.
- Registrar decisões e transições nas fontes apropriadas.

## Política de contexto

Priorizar:
1. Objetivo e critérios de aceite.
2. Resultado da etapa anterior.
3. Artefatos modificados.
4. Problemas pendentes.
5. Referências para consulta adicional.

Não transmitir históricos completos por padrão.

## Política de falhas

Quando um agente falhar:
- Preservar resultados parciais.
- Registrar evidências.
- Identificar a causa conhecida.
- Evitar repetição sem mudança de estratégia.
- Respeitar os limites de tentativas e aprovação humana.
