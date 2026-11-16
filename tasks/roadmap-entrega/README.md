# Roadmap de entrega do Espectro (SDD)

> **Status:** PROPOSTA de 15/11/2026, aguardando aprovação do Richard. Nada implementado.
> Base: estudo de `main` em `a4e3899`. Documento completo, com riscos e rastreabilidade
> dos candidatos C01–C35: [Espectro — Roadmap de entrega](https://claude.ai/artifact/4aeBzR9oNB9VQqD7bG8r6R).

O Espectro mede bem e ainda não reduz nada: o gargalo é fechar o que já está construído.
Este diretório organiza o trabalho em fases e fatias, com uma spec por fatia, escrita só
quando a fatia vai começar.

## Estrutura

```text
ROADMAP.md         na raiz do repo: mapa raso com fases, ordem e status
tasks/roadmap-entrega/
├── README.md      este arquivo: estrutura e regras
├── DECISOES.md    D1–D10: premissa assumida, alternativa, efeito na ordem
├── LINEAR.md      reconciliação com as issues abertas: vínculos e conflitos
├── fase-N-<nome>/
│   ├── FASE.md    objetivo, critério de saída, tabela de fatias (fonte única das fatias)
│   └── fN-M-<nome>/   criado quando a fatia começa: SPEC.md, plan.md, todo.md
└── arquivo/       fatias concluídas ou removidas, movidas inteiras
```

## Regras da estrutura

1. **Três níveis, cada um com um dono de informação.** [`ROADMAP.md`](../../ROADMAP.md), na raiz, ordena fases. `FASE.md`
   lista fatias e o critério de saída. A spec da fatia diz o quê; `plan.md` diz como. Nada se
   repete entre níveis: o nível de cima aponta para o de baixo.
2. **O mapa é raso.** Ele nomeia, limita e ordena. Desenho técnico só dentro da spec da fatia.
3. **ID estável.** `F<fase>.<n>` nunca muda nem é reutilizado. Fatia cortada vira
   `(removida em AAAA-MM-DD: motivo)`. O ID entra na issue do Linear, na branch e no PR.
4. **Spec na hora.** A pasta da fatia nasce quando ela entra no cycle, não antes. Leve não
   tem SPEC (os ACs ficam no `FASE.md` e na issue); Médio, até 1 página se preciso; Alto, 1 a
   2 páginas. É a regra 5 do `CLAUDE.md`.
5. **Decisão fora da spec.** Premissas e decisões do Richard moram em `DECISOES.md`. A fatia
   cita o ID (`D1`), não copia o texto.
6. **Plano é descartável.** `plan.md` e `todo.md` servem à fatia em curso. A evidência vai no
   PR. Fatia fechada vai para `arquivo/`.
7. **Gate por fase.** Uma fase só abre quando o critério de saída da anterior está marcado no
   `FASE.md` dela, ou quando o Richard registra a exceção em `DECISOES.md`.
8. **Linear continua sendo o gestor do trabalho.** Status operacional (em andamento, bloqueio)
   mora na issue. Aqui fica só o estado da fatia: `não iniciada`, `em spec`, `em andamento`,
   `ligada`, `concluída`, `removida`.

## O que vale para toda fatia

- Processo, níveis, AUTORIZO e PR: [`CLAUDE.md`](../../CLAUDE.md) e [`AGENTS.md`](../../AGENTS.md).
  Não repetir aqui.
- Testes: receita oficial do [`README.md`](../../README.md#primeiros-passos). Checagens
  estáticas: `npm --prefix scripts run check:js && npm --prefix scripts run arch:check`.
- Comportamento novo nasce atrás de flag desligada e entra no registro de flags (F1.1) no
  mesmo PR.
- No máximo duas frentes por fase e um piloto de custo por vez.
- Nunca: ligar flag no consumidor antes de F1.1, F1.2 e F1.3; afirmar ganho de custo sem a
  linha de base (F1.5); copiar dado do consumidor para este repo ou para o Linear.

## Por que esta estrutura

| Fonte | O que foi adotado | O que ficou de fora |
| -- | -- | -- |
| Spec Kit (`specs/NNN/` com spec, plan, tasks; constituição) | Uma pasta por unidade de trabalho com três artefatos | Constituição nova: `CLAUDE.md` e `AGENTS.md` já cumprem o papel |
| Roadmap acima das specs (prática descrita para o Spec Kit) | Mapa raso com ID estável, intenção, limite, dependência, status e link | Desenho dentro do mapa |
| Kiro (uma spec por feature, não uma para o projeto todo) | Uma spec por fatia; a fase não tem spec | `requirements.md` + `design.md` separados |
| OpenSpec (verdade corrente × mudança proposta × arquivo) | `arquivo/` para o que fechou | Deltas de spec: o repo não tem specs de comportamento |
| INNOQ, custos ocultos do SDD | Spec curta e na hora, plano descartável, decisão fora da spec | Detalhar todas as fatias de antemão |

Fontes: [Spec Kit](https://github.com/github/spec-kit) ·
[roadmap sobre o Spec Kit](https://habr.com/ru/articles/1063940/) ·
[Kiro, boas práticas](https://kiro.dev/docs/specs/best-practices/) ·
[OpenSpec, conceitos](https://openspec.dev/docs/core-concepts) ·
[INNOQ](https://www.innoq.com/en/blog/2026/04/versteckte-kosten-spec-driven-development/)
