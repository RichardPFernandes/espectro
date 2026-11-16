---
name: prisma-handoff
description: Produz ou valida handoff YAML opcional do contrato Maestri no Prisma a partir do template e docs/handoff-contract.md, e roda scripts/validate-handoff.js. Use só quando o coordenador Maestri pedir uma transferência entre agentes; pelo Acordo v2 nenhuma fatia exige handoff.
---

> Skill de produção do Prisma (workflow Cursor); não é runtime do produto; não substitui gates/scripts.

**Faixa de modelo:** leve (fecho limpo); médio se bloqueio denso — sem Opus. Ver `.agents/reference/skill-model-map.md`.

# prisma-handoff

Atalho para o contrato já autoritativo. **Autoridade =** `docs/handoff-contract.md` + `templates/handoff.yaml.template` + `node scripts/validate-handoff.js`. Esta skill não redefine campos nem aprova evidência.

## Objetivo

Entregar handoff YAML válido **quando o coordenador Maestri pedir** uma transferência entre agentes. Pelo Acordo v2 o handoff é opcional: o status fica no topo da issue e a evidência na seção Evidência do PR (AGENTS.md §9). Não gravar `handoff-*.yaml` em `tasks/**` por padrão.

## Template

1. Partir de `templates/handoff.yaml.template` e ler `docs/handoff-contract.md`.
2. YAML obrigatório: arquivo `.yaml` ou fence ` ```yaml ` dentro de `.md`. Prosa solta **não** conta.
3. Usar `handoff_version: "1.2"` (campos `routing`, `risk` e `nivel_processo` obrigatórios; motivo em `nivel_processo_motivo` se o nível mudou).
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
- Inventar config/estado/credencial de **consumidor** no handoff da plataforma (AGENTS.md §6).

## Common Rationalizations

| Racionalização | Realidade |
| --- | --- |
| “Prosa no chat basta” | Contrato exige YAML; validador não lê narrativa solta. |
| “PASSED — eu rodei mentalmente” | Sem `evidence` atribuível = não PASSED. |
| “Vou fechar a issue no Linear com o handoff” | Handoff ≠ Done/Approval; só transfere. |
| “Copio o state do consumidor pro próximo agente” | Transporte de código ≠ dados/credenciais/fixtures do consumidor. |

## Red Flags

- `validation.executed` com PASSED e `evidence` vazio.
- Status COMPLETED com `open_issues` que bloqueiam o próximo passo.
- Handoff usado para avançar nó do watcher / gravar `state.json`.
- Mistura de paths de consumidor secreto com artefatos da plataforma.

## Verification

- [ ] YAML válido (`handoff_version`, routing/risk se 1.1+, `nivel_processo` se 1.2)
- [ ] `node scripts/validate-handoff.js <arquivo>` sem ERROR
- [ ] Fatos vs assumptions separados; UNKNOWN preservado
- [ ] Artefatos referenciados por path (não colados inteiros)

## Distinção rápida

| Artefato | Papel |
| --- | --- |
| Este contrato (`docs/handoff-contract.md`) | Transferência entre agentes Maestri / coordenação |
| `memory/runs/<task>/handoff.md` | Estado operacional do nó do grafo |

Sem pedido do coordenador, bloqueio vira comentário de 3 linhas na issue (Bloqueio / Por quê ou quem decide / Efeito), não handoff.

Anatomia: [`.agents/reference/skill-anatomy.md`](../../reference/skill-anatomy.md).
