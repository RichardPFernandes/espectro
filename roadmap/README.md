# Roadmap de entrega do Espectro (SDD)

> **Status:** PROPOSTA de 15/11/2026, aguardando aprovação do Richard. Nada implementado.
> Base: estudo de `main` em `a4e3899`. Diagnóstico, evidências, riscos e rastreabilidade dos
> candidatos C01–C35: [`BASE.md`](BASE.md).

O Espectro mede bem e ainda não reduz nada: o gargalo é fechar o que já está construído.
O `ROADMAP.md` da raiz e este diretório organizam o trabalho em fases e fatias, com uma spec por fatia, escrita só
quando a fatia vai começar.

## Estrutura

```text
ROADMAP.md             mapa raso: fases, ordem, status
roadmap/
├── README.md          este arquivo: estrutura e regras
├── DECISOES.md        D1–D14: premissa assumida, alternativa, efeito na ordem
├── LINEAR.md          reconciliação com as issues abertas: vínculos e conflitos
├── PONTE.md           tabela-ponte: destino de cada página do design e de cada macrofase da arquitetura
├── BASE.md            por que o roadmap é este: diagnóstico, evidências, riscos
├── DADOS.md           números reais de runs (só agregados) e o que mudam na ordem
├── ACOMPANHAMENTO.md  métricas semanais, rito e série
├── fase-N-<nome>/
│   └── FASE.md        objetivo, critério de saída, tabela de fatias (fonte única das fatias)
└── arquivo/           fases fechadas, movidas inteiras
tasks/fN-M-<nome>/     criado quando a fatia começa: SPEC.md, plan.md, todo.md
```

## Regras da estrutura

1. **Três níveis, cada um com um dono de informação.** [`ROADMAP.md`](../ROADMAP.md), na raiz, ordena fases. `FASE.md`
   lista fatias e o critério de saída. A spec da fatia diz o quê; `plan.md` diz como. Nada se
   repete entre níveis: o nível de cima aponta para o de baixo.
2. **O mapa é raso.** Ele nomeia, limita e ordena. Desenho técnico só dentro da spec da fatia.
3. **ID estável.** `F<fase>.<n>` nunca muda nem é reutilizado. Fatia cortada vira
   `(removida em AAAA-MM-DD: motivo)`. O ID entra na issue do Linear, na branch e no PR.
4. **Spec na hora, em `tasks/`.** A pasta da fatia nasce em `tasks/fN-M-<nome>/` quando ela
   entra no cycle, não antes. Fica em `tasks/` porque é lá que o `processo-check` vigia SPEC nova. Leve não
   tem SPEC (os ACs ficam no `FASE.md` e na issue); Médio, até 1 página se preciso; Alto, 1 a
   2 páginas. É a regra 5 do `CLAUDE.md`.
5. **Decisão fora da spec.** Premissas e decisões do Richard moram em `DECISOES.md`. A fatia
   cita o ID (`D1`), não copia o texto.
6. **Plano é descartável.** `plan.md` e `todo.md` servem à fatia em curso. A evidência vai no
   PR. A pasta da fatia em `tasks/` pode ser apagada depois do merge.
7. **Gate por fase.** Uma fase só abre quando o critério de saída da anterior está marcado no
   `FASE.md` dela, ou quando o Richard registra a exceção em `DECISOES.md`.
8. **O Linear manda no status.** Em andamento, bloqueio e conclusão moram na issue. O
   `FASE.md` guarda só o estado da fatia (`não iniciada`, `em spec`, `em andamento`, `ligada`,
   `concluída`, `removida`) e é atualizado no PR que muda esse estado. Se os dois divergirem,
   vale a issue e corrige-se o `FASE.md`. O `/pri-pr` também mantém, na linha da fatia, o
   `Nível` e a `Issue no Linear`, e marca o critério de saída que a fatia cumpre. Fatias que
   dividem uma issue fecham pelos próprios ACs, não pela issue inteira.
9. **`tasks/` só tem o que está em curso.** Pasta de issue fechada vai para `docs/historico/`
   (a F0.14 moveu as de issue Done; a da PRI-233 já tinha ido em 16/11, porque travava os
   comandos do agent-skills). Um arquivo que o código cita por caminho não se move: as provas
   `u10-probe-evidence*.json` da PRI-287 ficam em `tasks/pri-287-s5/`. Pastas
   `tasks/fN-M-<nome>/` pertencem a este roadmap.

## O que vale para toda fatia

- Processo, níveis, AUTORIZO e PR: [`CLAUDE.md`](../CLAUDE.md) e [`AGENTS.md`](../AGENTS.md).
  Não repetir aqui.
- Testes: receita oficial do [`README.md`](../README.md#primeiros-passos). Checagens
  estáticas: `npm --prefix scripts run check:js && npm --prefix scripts run arch:check`.
- Comportamento novo nasce atrás de flag desligada e entra no registro de flags
  ([`docs/flags.md`](../docs/flags.md), F1.1) no mesmo PR, com data de decisão; o CI falha sem ela.
- No máximo duas frentes por fase e um piloto de custo por vez.
- Validar o mapa (IDs, dependências, status, links, decisões): `node scripts/lib/roadmap-lint.js`
  (exit 1 se houver erro; também roda no `npm test` de `scripts`).
- Página visual (progresso por fase, linha do tempo, grafo de dependências, fatias Alto):
  <https://richardpfernandes.github.io/espectro/>. O workflow `roadmap-pages.yml` a gera com
  `scripts/lib/roadmap-site.js` a cada merge na `main` que mexe em `ROADMAP.md`, `roadmap/**` ou no
  gerador; nada gerado entra no repo. Teste local: `node scripts/lib/roadmap-site.js . /tmp/site`.
- Modelo da SPEC de fatia: [`templates/fatia-spec.md.template`](../templates/fatia-spec.md.template),
  copiado para `tasks/fN-M-<nome>/SPEC.md` quando a fatia entra no cycle.
- Nunca: ligar flag no consumidor corporativo antes de F1.1, F1.2 e F1.3 (o launcher do
  piloto no próprio Espectro segue D11); afirmar ganho de custo sem a linha de base (F1.5);
  copiar dado do consumidor para este repo ou para o Linear.

## Por que esta estrutura

| Fonte | O que foi adotado | O que ficou de fora |
| -- | -- | -- |
| Spec Kit (`specs/NNN/` com spec, plan, tasks; constituição) | Uma pasta por unidade de trabalho com três artefatos | Constituição nova: `CLAUDE.md` e `AGENTS.md` já cumprem o papel |
| Roadmap acima das specs (prática descrita para o Spec Kit) | Mapa raso com ID estável, intenção, limite, dependência, status e link | Desenho dentro do mapa |
| Kiro (uma spec por feature, não uma para o projeto todo) | Uma spec por fatia; a fase não tem spec | `requirements.md` + `design.md` separados |
| OpenSpec (verdade corrente × mudança proposta × arquivo) | `arquivo/` para o que fechou | Deltas de spec: o repo não tem specs de comportamento |
| INNOQ, custos ocultos do SDD | Spec curta e na hora, plano descartável, decisão fora da spec | Detalhar todas as fatias de antemão |

Fontes: [Spec Kit](https://github.com/github/spec-kit) · [roadmap sobre o Spec Kit](https://habr.com/ru/articles/1063940/) · [Kiro](https://kiro.dev/docs/specs/best-practices/) · [OpenSpec](https://openspec.dev/docs/core-concepts) · [INNOQ](https://www.innoq.com/en/blog/2026/04/versteckte-kosten-spec-driven-development/)
