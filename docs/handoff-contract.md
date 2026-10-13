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
Validador: `node scripts/validate-handoff.js <handoff.yaml|handoff.md> [--check-paths]`.

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
| Planejamento/documental — demais entregas documentais | Handoff com fatos verificáveis e referências aos artefatos, conforme este contrato; critérios adicionais de encerramento: a definir pelo Richard. | Conferência do handoff pelo coordenador; confirmação de Done: a definir pelo Richard. |
| Implementação (feature/refactor) | Handoff com artefatos, revisão independente, testes/Verify aplicáveis e evidências atribuíveis à versão, conforme o ciclo vigente. Critérios adicionais de Done e relação entre merge e encerramento: a definir pelo Richard. | Revisor/QA confirmam somente os resultados técnicos do seu escopo; confirmação de Done: a definir pelo Richard. Merge exclusivo do Richard. |
| Correção de bug | Handoff com evidências exigidas pelos critérios de aceite da issue, revisão independente e testes/Verify aplicáveis, atribuíveis à versão. Não presumir reprodução, cobertura ou teste não executado. Critérios adicionais de Done: a definir pelo Richard. | Revisor/QA confirmam somente os resultados técnicos do seu escopo; confirmação de Done: a definir pelo Richard. Merge exclusivo do Richard. |
| Investigação/discovery (só leitura) | Handoff com fontes/versões, escopo observado, resultados e limites verificáveis; distinguir fatos, hipóteses e UNKNOWN. Critérios adicionais de Done: a definir pelo Richard. | Conferência do handoff pelo coordenador; confirmação de Done: a definir pelo Richard. |
| Revisão/QA | Handoff com escopo/versão revisados, achados e evidências das verificações efetivamente executadas, separadas das não executadas. Critérios adicionais de Done: a definir pelo Richard. | Revisor/QA confirmam o resultado técnico da própria etapa; confirmação de Done: a definir pelo Richard. |

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
Esta seção não acrescenta campos ao handoff nem altera o validador.

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
