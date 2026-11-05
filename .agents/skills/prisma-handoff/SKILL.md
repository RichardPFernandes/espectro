---
name: prisma-handoff
description: Produz ou valida handoff YAML do contrato Maestri no Prisma a partir do template e docs/handoff-contract.md, e roda scripts/validate-handoff.js. Use ao concluir, bloquear ou interromper tarefa delegada (AGENTS.md §9).
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve (fecho limpo); médio se bloqueio denso — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-handoff

Atalho para o contrato já autoritativo. **Autoridade =** `docs/handoff-contract.md` + `templates/handoff.yaml.template` + `node scripts/validate-handoff.js`. Esta skill não redefine campos nem aprova evidência.

## Objetivo

Ao concluir, bloquear ou interromper tarefa delegada, entregar handoff YAML válido (AGENTS.md §9).

## Template

1. Partir de `templates/handoff.yaml.template` e ler `docs/handoff-contract.md`.
2. YAML obrigatório: arquivo `.yaml` ou fence ` ```yaml ` dentro de `.md`. Prosa solta **não** conta.
3. Preferir `handoff_version: "1.1"` (campos `routing` e `risk` obrigatórios).
4. Preservar IDs Linear, ACs, decisões aprovadas vs hipóteses (`decisions.approved` / `proposed`, `facts` / `assumptions`), e refs de evidência — referenciar artefatos em vez de colar documentos inteiros.

## Validação

```bash
node scripts/validate-handoff.js <handoff.yaml|handoff.md> [--check-paths] [--pre-done] [--task-type "<tipo da tabela>"]
```

- `ERROR` impede aceitação; `WARN` registra sem bloquear.
- O validador confere forma/coerência, **não** reexecuta testes.
- Use `--check-paths` / `--pre-done` quando o contrato e o perfil da tarefa pedirem.

## Anti-padrões

- Declarar teste `PASSED` sem execução comprovada em `evidence`.
- Modificar requisitos ou decisões já aprovadas sem autorização.
- Tratar este handoff Maestri como substituto de `memory/runs/<task>/handoff.md` do grafo (`.claude/commands/*`): o handoff do grafo continua o estado operacional da run; este contrato **referencia** aquele path em `context_refs` quando couber.
- Usar handoff para “fechar” Done/Approval Gate ou avançar nó do ciclo.
- Transformar UNKNOWN ou ausência de prova em aprovação.

## Distinção rápida

| Artefato | Papel |
| --- | --- |
| Este contrato (`docs/handoff-contract.md`) | Transferência entre agentes Maestri / coordenação |
| `memory/runs/<task>/handoff.md` | Estado operacional do nó do grafo |

Bloqueio e interrupção também geram handoff — não só conclusão feliz.
