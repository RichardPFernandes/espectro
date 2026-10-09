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
