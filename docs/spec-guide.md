> Candidata extraída PRI-60. Os exemplos/histórico de app-back neste documento
> identificam a origem, não configuram o consumidor atual. Consulte docs/consumption.md
> e docs/extraction-paths.md: comandos de plataforma em PRISMA_ROOT, cwd/REPO_PATH
> e configuração/estado no consumidor. Nenhum procedimento de recovery/cutover
> é autorizado por esta cópia. A fonte histórica continua atribuída no manifesto.

# Guia de preenchimento da spec

Toda demanda nova começa de `templates/spec.md.template` (versão 1). O `/fetch-ticket`
copia o template para `memory/spec/<ticket>-spec.md` e preenche **só** o que vem do
Redmine: número, título e descrição (em `## Contexto`). O resto é com você.

A spec responde **O QUÊ** entregar. O **COMO** é do `/plan`
(`memory/runs/<task-id>/plan.md`). Em divergência entre os dois, a spec vence
(`memory/decisions/2026-09-30-spec-what-plan-how.md`).

## Fluxo

1. Abra `memory/spec/<ticket>-spec.md`.
2. Em cada seção, leia o comentário `<!-- ... -->`, escreva o conteúdo e **apague o
   comentário**. Seção opcional que não se aplica: apague a seção inteira.
3. Valide:

   ```
   node "$PRISMA_ROOT/scripts/lib/spec-validator.js" memory/spec/<ticket>-spec.md
   ```

4. Com exit 0, o portão do watcher libera o `/plan` no próximo tick.

Não mexa em `spec_template_version` no frontmatter. É o que diz ao validador qual
versão de regras aplicar, e vai para o `state.json` do run.

## Seções

| Seção | Obrigatória | Responde |
|---|---|---|
| `## Contexto` | sim | Qual é o problema hoje? |
| `## Objetivo` | sim | Como sabemos que deu certo? |
| `## Escopo` | sim | O que entra e o que não entra? |
| `## Critérios de Aceite` | sim | O que o QA verifica, item a item? |
| `## Dependências Técnicas` | não | O que precisa existir antes ou junto? |
| `## Restrições` | não | Que limites a solução precisa respeitar? |
| `## Referências` | não | Onde está o material de apoio? |

O cabeçalho precisa ser **exatamente** o da tabela: nível `##`, com acento e caixa
iguais. `### Contexto` ou `## Criterios de aceite` não contam como a seção.

## Contexto × Objetivo

**Contexto é o problema.** Descreve a situação atual, quem é afetado, com que
frequência e por que precisa mudar agora. São fatos. Não traz solução.

**Objetivo é o critério de sucesso.** Em uma ou duas frases, diz como o mundo fica
depois da entrega e como saber que deu certo. Não traz implementação.

| | Contexto (problema) | Objetivo (critério de sucesso) |
|---|---|---|
| Bom | "A transportadora não consegue reenviar a NF rejeitada pela SEFAZ: hoje abre chamado e o suporte reenvia à mão (~30 chamados/mês)." | "A transportadora reenvia a NF rejeitada pela API, sem abrir chamado." |
| Ruim | "Precisamos criar um endpoint de reenvio." (é solução, não problema) | "Criar o `ReenvioNotaFiscalService`." (é implementação, não sucesso) |

Teste rápido: se a frase do Objetivo continuaria verdadeira com outra implementação
qualquer, ela está no nível certo.

## Critérios de Aceite verificáveis

Cada AC é uma linha `- AC-NN: <critério>`, com IDs em sequência a partir de `AC-01`.
É obrigatório ter pelo menos um. Um bom AC pode ser verificado por alguém de QA
sem perguntar nada a ninguém: tem condição, resultado observável e, quando cabe,
limite ou medida.

| Ruim (vago) | Bom (verificável) |
|---|---|
| O sistema deve funcionar corretamente | AC-01: Ao enviar formulário com campo obrigatório vazio, exibir mensagem de erro inline abaixo do campo em até 200ms |
| A busca deve ser rápida | AC-02: A busca de rotas por descrição com 10 mil rotas cadastradas retorna em até 2s |
| Melhorar o filtro de cargas | AC-03: Ao selecionar "Remessa" no filtro Tipo, a grade exibe somente cargas do tipo Remessa |
| Tratar erros da integração | AC-04: Quando a SEFAZ responde rejeição, o status da NF muda para "Rejeitada" e o motivo retornado aparece na coluna Observação |
| Não quebrar nada | AC-05: O filtro por unidade continua retornando o mesmo resultado de antes para os mesmos parâmetros |

Sinais de AC vago: "corretamente", "adequado", "rápido", "melhorar", "tratar",
"etc.", e qualquer critério que dependa da opinião de quem testa.

IDs são para sempre. Critério novo ganha o próximo número livre. Critério que deixou
de valer não é apagado: vira
`- AC-03: (removido em 2026-10-02: motivo) <texto original>`.

## Restrições × Critérios de Aceite

- **Critério de Aceite** é um comportamento novo ou alterado que o QA verifica
  executando o sistema. Se dá para escrever "ao fazer X, acontece Y", é AC.
- **Restrição** é um limite que a solução respeita sem ser, ela mesma, a entrega:
  não alterar o contrato do endpoint X, não exigir migração de dados, publicar só na
  janela de sábado, manter compatibilidade com o cliente Y. Vale também
  `memory/project.yaml > regras_invioláveis`.

Uma restrição que precisa ser **provada** depois da entrega vira AC de regressão.
Exemplo: "AC-05: o filtro por unidade continua retornando o mesmo resultado". Se ela
só orienta a solução, fica em Restrições.

## O que NÃO pertence à spec

O que segue é decisão de **como**, e vai para o `plan.md`:

- nome de classe, método, tabela, coluna ou endpoint a criar;
- escolha de biblioteca, framework, padrão de projeto ou estrutura de pacotes;
- ordem de implementação, arquivos a tocar, estratégia de teste;
- trechos de código, SQL ou pseudocódigo.

Exceção: quando o nome é parte do **contrato externo** pedido (ex: o ticket exige o
campo `codigoRastreio` na resposta da API pública), ele é comportamento e pode
aparecer no AC.

Se você está escrevendo "criar o service X" na spec, pergunte "para quê?". A resposta
é o AC.

## Incerteza: `[PENDING_CLARIFICATION]`

Quando um critério depende de uma resposta que ainda não veio, não invente nem omita.
Escreva o AC e marque:

```
- AC-03: [PENDING_CLARIFICATION] Limite de itens por página na listagem — aguardando definição do PO
```

- O validador **aceita** a spec (aviso `PENDING_CLARIFICATION`, sem reprovar).
- O `/plan` **não roda** enquanto houver marcador: o watcher pausa a task
  (`spec-invalid`) e comenta no Redmine, e o próprio `/plan` para no passo 0.
  Responder "aceito" no ticket **não** libera esse bloqueio.
- Para destravar: obtenha a resposta, reescreva o critério e remova o marcador. O
  próximo tick do watcher segue sozinho.

Use o marcador para dúvida pontual. Se a maior parte dos critérios está incerta, a
demanda ainda não está pronta para entrar no pipeline.

## O que o validador cobra (template v1)

| Código | Quando | Efeito |
|---|---|---|
| `MISSING_REQUIRED_SECTION` | falta `## Contexto`, `## Objetivo`, `## Escopo` ou `## Critérios de Aceite` com o cabeçalho exato | reprova |
| `SECTION_NOT_FILLED` | seção obrigatória só com o comentário do template (ou vazia) | reprova |
| `NO_ACCEPTANCE_CRITERIA` | `## Critérios de Aceite` sem nenhuma linha `- AC-NN:` | reprova |
| `TEMPLATE_COMMENTS_PRESENT` | algum comentário de instrução do template continua no arquivo | reprova |
| `AC_ID_*`, `AC_EMPTY_TEXT` | ID fora do padrão, duplicado, fora de sequência ou sem texto | reprova |
| `PENDING_CLARIFICATION` | critério com `[PENDING_CLARIFICATION]` | aviso; bloqueia o `/plan` |
| `SPEC_TEMPLATE_VERSION_MISSING` | spec sem `spec_template_version` (legada) | aviso; usa as regras antigas |

Specs anteriores ao template (`memory/spec/*` sem `spec_template_version`) **não
precisam ser migradas**. Continuam validadas pelas regras antigas
(`## Problema`/`## Solução`/`## Critérios de Aceite`) e só recebem o aviso.
