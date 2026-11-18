# Plano F0.9 AC-03 (PRI-399, Médio)

Escopo: só o AC-03. O AC-01 foi mesclado (PR #186, plano anterior no histórico do Git). O
AC-02 (Action no merge) espera o secret `LINEAR_API_KEY` e fica fora.

**AC-03.** O relatório semanal traz as cinco métricas de `roadmap/ACOMPANHAMENTO.md`, cada uma
com n e fonte; sem medição aparece como desconhecido.

## Onde fica o relatório

No **Relatório semanal do dashboard** (`dashboard/public/weekly-report.js`), que o
`ACOMPANHAMENTO.md` já cita como fonte da métrica 1. Uma Action do GitHub não lê o
`state.json` dos runs (fica na máquina do consumidor), então não serve para M1 e M2.

| # | Métrica | De onde sai | Hoje |
| -- | -- | -- | -- |
| 1 | Custo por ticket entregue | `ticketCosts` (F1.5), já no relatório | medida |
| 2 | Primeira passada e custo do retrabalho | `aggregate.firstPass` + soma de `reworkBaseline` (F1.4) | medida |
| 3 | Runs bloqueadas pelo teto e acima de N× a mediana | F1.3 e F3.4 não entregues; N não definido | desconhecido |
| 4 | Estoque desligado | `docs/flags.md` (F1.1): flags por padrão, vencidas, itens desligados | passa a ser medida |
| 5 | Fluxo (frentes, issues, cycle) | Linear, à mão; o dashboard não lê o Linear | desconhecido |

## Decisões de desenho

- **M4 por processo.** A regra G3 proíbe o dashboard de importar `scripts/lib`. Um leitor
  `scripts/flags-read.js --json` usa o parser que já existe (`parseFlagRegistry`, `todayUtc`)
  e o servidor o chama, como o `effort-miss-read.js`. Rota nova, só leitura:
  `GET /api/flags-summary`; falha vira `UNKNOWN` (502), nunca zero.
- **M3 e M5 não são inventadas.** Aparecem como desconhecido, com o motivo e a fonte
  ("não medida, F1.3/F3.4"; "Linear, à mão"). Não calculo "N× a mediana" sem N definido.
- **Uma função pura** `fiveMetrics(M, flags)` monta as cinco linhas (valor, n, fonte,
  conhecida). A tela (seção na capa) e o "Copiar resumo" leem dela. A "Linha para a série"
  passa a trazer as cinco colunas da tabela do `ACOMPANHAMENTO.md`, não só o custo.
- **Sem flag.** O relatório é de leitura e não muda nada no consumidor (mesmo caminho da
  F1.4 e da F1.5). Se o Richard quiser flag, entra no registro antes do build.

## Prova

`npm run test:changed` em cada tarefa; `npm test` e `npm run check` no `/pri-check`;
`node scripts/lib/flag-registry.test.js` verde. Demonstração: o relatório semanal com o
`DRY_RUN` mostrando as cinco métricas e o texto do "Copiar resumo", na Evidência do PR.
Revisão G3: `agent-skills:code-reviewer` (opus, contexto limpo).

## Riscos

| Risco | Mitigação |
| -- | -- |
| `docs/flags.md` muda de formato | O leitor devolve `ok:false` e a M4 vira desconhecido; o teste do registro já barra cabeçalho errado no CI |
| Dashboard rodando de um checkout sem `docs/flags.md` | Caminho resolvido a partir do próprio script; ausência = desconhecido |
| "Primeira passada" com duas leituras (por run e por nó) | M2 usa a por run (mesma da linha de base de 16/11) e cita o n; a por nó segue na seção da F1.4 |
