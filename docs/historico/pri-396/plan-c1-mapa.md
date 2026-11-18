# Plano C1: mapa de capacidades do Espectro

SPEC: [`SPEC-c1-mapa.md`](SPEC-c1-mapa.md). Tarefas: [`todo-c1-mapa.md`](todo-c1-mapa.md). Issue: PRI-396 (Médio). Código lido em `main` `73a5dba`.

## Resumo

Nove tarefas em três fases, um PR em draft (`Refs PRI-396`, rótulo `processo:medio`). A fase 1
faz o script e as regras, provadas com casos sintéticos e uma capacidade real. A fase 2
classifica os 233 arquivos nas 16 capacidades e liga a regra de cobertura no repo. A fase 3
escreve a página de entrada, gera a tabela e põe os ponteiros. Toda tarefa de código começa
pelo teste que falha.

## Decisões de desenho

1. **A fonte é o cabeçalho de cada `docs/capacidades/<id>.md`.** Não há arquivo de índice
   separado. A tabela do `README.md` é gerada dele, entre marcadores, por `--write`. Assim a
   mesma informação não é escrita à mão em dois lugares.
2. **Um script só: `scripts/capability-map.js`.** Funções puras exportadas (ler cabeçalho,
   achar o dono, conferir cobertura, conferir links, montar a tabela) e um `main` com `--check`,
   `--write` e `--of`. O teste importa as funções; não chama o CLI por processo, salvo no AC-06.
   Fica na raiz de `scripts/`, como os outros CLIs, e não importa nada de `scripts/lib`.
3. **Padrão simples, um dono por arquivo.** Um padrão é caminho exato ou prefixo terminado em
   `*`. Não há precedência: se dois padrões casam com o mesmo arquivo, é erro. Isso obriga a
   escrever a fronteira, em vez de escondê-la numa regra de desempate.
4. **O que entra na cobertura fica declarado num lugar.** Uma constante no script lista as
   raízes: `.js`, `.mjs`, `.cjs` e `.sh` de `scripts/` e `dashboard/`, e todo arquivo de
   `.claude/commands/` e `.graph/`. Ficam de fora `*.test.js`, `fixtures/` e `.gitkeep`.
5. **Regra a mais, contra mapa inventado:** toda flag listada no cabeçalho aparece, por nome,
   em algum arquivo da própria capacidade. Entrou no AC-02 da SPEC ao planejar.
6. **A cobertura só liga no repo quando o mapa fecha.** Nas fases 1 e 2 a regra roda em casos
   sintéticos e o `--check` mostra quantos arquivos faltam. O teste contra o repo real entra na
   T5. A suíte fica verde em toda tarefa.
7. **Classificar é ler, não adivinhar pelo nome.** Em cada capacidade: abrir o cabeçalho dos
   arquivos, conferir quem importa quem e achar onde cada flag é lida. O que mudar de lugar em
   relação à `PROPOSTA.md` é listado no PR.
8. **Branch própria a partir da `main`.** O worktree `testes` tem trabalho de outras issues sem
   commit. A C1 roda em worktree novo, na branch `fernandesrichard312/pri-396-c1-mapa-de-capacidades-do`,
   levando a pasta `tasks/spec-viva-do-espectro/`.

## Ordem e dependências

```text
T1 cabeçalho + dono (--of) ─┬─ T2 regras de cobertura e de flag (sintético)
                            │        │
                            │        ├─ T3 base e ciclo ──┐
                            │        ├─ T4 produto ───────┼─ T5 bordas + cobertura ligada no repo
                            │        └─ (T3 e T4 em paralelo)
                            └─ T8 links (independente)
T5 ─ T6 README (visão, ciclo, glossário) ─ T7 tabela gerada ─ T9 ponteiros
```

T3 e T4 podem rodar em paralelo, por agentes diferentes, depois da T2: o contrato do cabeçalho
já está fixo e as capacidades não dividem arquivo. A T5 fecha o que sobrar e resolve conflito.

## Pontos de conferência

- **A, depois da T2:** as regras falham nos casos sintéticos certos; `--of scripts/cas.js` responde `estado`.
- **B, depois da T5:** `--check` sai 0 no repo; lista do que mudou em relação à proposta pronta. É o ponto de maior risco: se as 16 capacidades não fecharem, a mudança de lista volta para o Richard antes da fase 3.
- **C, depois da T9:** `npm test` e `npm run check` verdes; revisão G3 por outro agente em contexto limpo; PR em draft com a Evidência por AC e as três perguntas do AC-09 em aberto para o Richard.

## Riscos

| Risco | Impacto | Como se trata |
| -- | -- | -- |
| Arquivo que serve a duas capacidades (por exemplo, `invalidate.js` entre `spec` e `estado`) | Médio | Um dono só; o outro lado cita o arquivo em "por onde começar". Casos duvidosos vão listados no PR |
| As 16 capacidades não fecham a conta | Médio | Ponto B. Criar, fundir ou cortar capacidade é "perguntar antes" |
| PRs em voo (PRI-393, PRI-395, F2.7) trazem arquivo sem dono depois do merge | Baixo | Prefixos com `*` cobrem as famílias; a mensagem de falha traz o comando `--of` e o arquivo a editar |
| `dashboard/public` tem 37 arquivos de interface, um por tela | Baixo | Um prefixo só (`dashboard/*`) na capacidade `dashboard`; dividir por tela é assunto da C2 |
| O README vira mais um documento longo | Médio | Teto de 150 linhas no teste; tabela gerada; AC-09 |
| Situação "ligada" escrita sem conferir | Alto para a confiança no mapa | Regra de flag (decisão 5) e caminho com linha na Evidência do PR |

## Perguntas abertas

Nenhuma.
