# Maestri — Agent Handoff Contract v1

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

## Estados permitidos

- COMPLETED: etapa concluída com evidências.
- BLOCKED: impedimento técnico ou operacional.
- NEEDS_HUMAN: decisão humana necessária.
- FAILED: etapa não concluída.
- PARTIAL: resultado parcial aproveitável.

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
