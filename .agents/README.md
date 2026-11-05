# Agentes — esteira de desenvolvimento Prisma

Skills e referências da **plataforma** (bootstrap). Viajam com o Prisma inserido em projetos consumidores. **Não** inventam config, credenciais ou estado do consumidor (AGENTS.md §4/§6). Path canônico: `.agents/skills/` (não migrar para `.cursor/skills/` sem decisão).

| Path | Uso |
| --- | --- |
| [`skills/*/SKILL.md`](./skills/) | Procedimento por ação |
| [`reference/skill-model-map.md`](./reference/skill-model-map.md) | Faixa de modelo sugerida (leve / médio / pesado) |
| [`reference/skill-model-map.yaml`](./reference/skill-model-map.yaml) | Mesmo mapa, estruturado |
| [`reference/subtask-routing.md`](./reference/subtask-routing.md) | Checklist na **criação** de subtarefa/worker |
| [`reference/subtask-routing.yaml`](./reference/subtask-routing.yaml) | Mesmo rito, estruturado |
| [`reference/context-packing.md`](./reference/context-packing.md) | O que carregar por sessão/worker |
| [`reference/orchestration-patterns.md`](./reference/orchestration-patterns.md) | Coordenador orquestra; fan-out barato |
| [`reference/skill-anatomy.md`](./reference/skill-anatomy.md) | Como escrever/editar skills (anti-racionalização) |
| [`playbook/`](./playbook/) | Ponteiro ação→skill + modelo |

**Opus só no pesado.** Planejamento: preferir Sonnet (qualidade). Tarefa bem simples → Sonnet. Ao criar subtarefa, classificar skill/faixa **antes** do spawn. Isto não muda o ciclo automático do produto, não liga S4, não mistura C1 PRI-181.
