<!--
Procedimento de sumarização condicional do context.md (memory/runs/<task-id>/context.md).

Quem executa: o próprio agente, como pré-passo dos nós Implement e Review
(.claude/commands/implement.md, .claude/commands/review.md e AGENTS.md > "Antes de
qualquer edição"). Não existe processo externo nem comando /summarize — é o agente
do nó que faz, antes de começar o trabalho do nó.

Por quê: cada nó APPENDa ao context.md. Depois de 3–4 ciclos implement↔review o
arquivo acumula 6–10 KB de histórico; o próximo agente lê tudo, perde foco, gasta
mais e pode repetir abordagem já descartada. Só o estado atual e as últimas falhas
importam — mas o objetivo e as decisões ativas nunca podem sumir.
-->

# Sumarização condicional do context.md

## 1. Limiar

Resolva o limiar `context_summarize_threshold_words` nesta ordem (o primeiro que
existir vence):

1. `memory/project.yaml` → chave `context_summarize_threshold_words`
2. `CLAUDE.md` → linha `context_summarize_threshold_words: <n>`
3. Padrão: **3000**

## 2. Medir

```bash
wc -w < memory/runs/<task-id>/context.md
```

- Arquivo não existe, ou contagem **≤ limiar** → **não toque o arquivo**. Nem
  reformate, nem acrescente metadado. Siga o nó normalmente.
- Contagem **> limiar** → sumarize (passo 3) e só depois siga o nó.

Use sempre a contagem do `wc -w`, nunca estimativa de cabeça. Isso deixa a decisão
reproduzível.

## 3. Sumarizar

### Guarde o original antes de sobrescrever

Copie o arquivo inteiro para `memory/runs/<task-id>/context.pre-sumarizacao-<AAAAMMDDTHHMMSSZ>.md`
(timestamp UTC). É só para auditoria e recuperação. Nenhum nó lê esse arquivo no
fluxo normal. Não o referencie em `handoff.md`.

### PRESERVE (nunca descarte)

- **Objetivo da task / spec original.** Nunca descartar. Se o context.md cita a
  spec, mantenha o caminho (`memory/spec/<ticket>-spec.md`) e o resumo do problema.
- **Decisões arquiteturais ainda válidas**, cada uma com o motivo.
- **Decisão marcada como inviolável, regra de negócio ou restrição** (inclusive as
  que citam `memory/project.yaml > regras_invioláveis`). Copie integralmente.
- **O que foi tentado e DESCARTADO**, com o motivo. É o que evita repetir erro.
- **Última falha registrada e sua causa identificada.** Se a última reprovação do
  Review ou falha de Test/Verify tem achados numerados, mantenha **todos** os
  achados dela, na íntegra.
- **Estado atual do código:** o que está implementado (arquivos/classes), o que
  falta. Inclua os repos relacionados explicitamente configurados e tocados, porque o
  Commit precisa saber.
- **Próximos passos definidos.**
- **Blocos que o watcher injeta. Copie VERBATIM, com os delimitadores:**
  - instruções humanas do dashboard, anexadas como `\n---\n<conteúdo>\n---\n`
    (também registradas em `state.json.human_inputs`, o que ajuda a reconhecê-las);
  - bloco de avisos do validador de spec, entre
    `<!-- spec-validator:avisos:inicio -->` e `<!-- spec-validator:avisos:fim -->`.
    O watcher atualiza esse bloco pelos marcadores, então não altere nada dentro
    nem os próprios marcadores.
- **Aceites e respostas do humano** (ex.: "aceito" no Redmine, respostas a
  perguntas de bloqueio), com data.

### DESCARTE

- Histórico detalhado de tentativas intermediárias que deram certo e já estão
  refletidas no "Estado atual".
- Logs de compilação/teste que não foram a causa de nenhuma falha.
- Reflexões do agente sobre abordagens que nunca foram tentadas nem descartadas
  explicitamente.
- Entrada antiga que foi **explicitamente substituída** por uma entrada mais
  recente sobre o mesmo assunto. O separador `---` sozinho não prova substituição:
  os blocos de instrução humana do watcher também usam `---` e são sempre
  preservados.

### Regra de dúvida

Se não tiver certeza se algo é importante, **MANTENHA**. A sumarização erra
para o lado conservador. Um resumo que continua acima do limiar é aceitável; um
resumo que perdeu uma decisão, não. Nunca reescreva o conteúdo técnico com outras
palavras a ponto de mudar o significado. Nomes de classe, campo, endpoint, regra e
número de ticket ficam exatamente como estavam.

## 4. Formato da versão sumarizada

A primeira linha do arquivo é **sempre** o metadado (comentário HTML, invisível em
render, fácil de detectar com grep):

```
<!-- context-sumarizado: <timestamp UTC ISO-8601> · nó <implement|review> · <N> → <M> palavras · original em context.pre-sumarizacao-<AAAAMMDDTHHMMSSZ>.md -->
# Contexto — <task-id> (sumarizado em <timestamp UTC ISO-8601>)
Versão original: <N> palavras → esta versão: <M> palavras

## Objetivo
<spec original: problema, solução esperada, critérios de aceite. Nunca vazio.>

## Decisões ativas
- <decisão> (<motivo>)

## Tentativas descartadas
- <abordagem> → descartada porque <motivo>

## Última falha
<nó que falhou, data, causa identificada, achados na íntegra. Se não houve: "Nenhuma registrada.">

## Estado atual
<implementado / pendente / repos tocados>

## Próximos passos
<lista>

## Instruções humanas e avisos preservados
<blocos do watcher copiados verbatim, com seus delimitadores. Omita a seção só se não havia nenhum.>
```

`<N>` = `wc -w` do original; `<M>` = `wc -w` do arquivo novo, medido **depois** de
escrito (corrija a linha se mudar). Uma seção sem conteúdo leva "Nenhuma." e nunca é
removida. "Objetivo" e "Decisões ativas" nunca podem ficar ausentes.

## 5. Depois de escrever

1. Confira: a linha 1 começa com `<!-- context-sumarizado:`, e as seções
   `## Objetivo` e `## Decisões ativas` existem e não estão vazias. Os blocos
   do watcher que existiam no original continuam presentes. Se algo falhar,
   restaure o original a partir do `context.pre-sumarizacao-*.md` e siga sem
   sumarizar. Isso é melhor que perder contexto.
2. Siga o nó normalmente usando o contexto sumarizado. Os appends deste nó
   (resumo do implement, veredito do review) entram **depois** do resumo, como
   sempre.
3. Registre em `state.json.agent_log` (na entrada do nó) uma nota curta:
   `context.md sumarizado <N> → <M> palavras`.

## Sumarizando de novo

Um context.md já sumarizado pode voltar a passar do limiar depois de mais ciclos.
Nesse caso sumarize de novo usando o resumo anterior como base: as seções dele
contam como conteúdo a PRESERVAR. A linha de metadado é substituída pela nova (só
uma no topo) e aponta para o novo `context.pre-sumarizacao-*.md`.
