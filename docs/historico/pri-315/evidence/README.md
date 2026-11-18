# PRI-315: evidência da medição (13/11/2026)

Claude Code 2.1.323, conta padrão do CLI (config pessoal, como na PRI-206 P0/P0b),
diretório de trabalho sintético, commit base `5560d29`. Ferramenta:
`scripts/probes/plan-cache-probe.js`. Os JSON guardam só contagens agregadas, sem transcript.

## Conclusão

**Na 2.1.323, `permissions.deny` ["Agent", "Task"] tira a ferramenta da lista igual ao
`--disallowedTools`.** A lista do plan com a flag é idêntica à do AS-IS, e as duas diferem da
lista do review. O prefixo do plan continua sem ser compartilhado com os outros nós, e o ganho
de cache que a PRI-206 previu (medido na 2.1.319) **não aparece**. Isso aciona o critério de
reversão "o read do 1º request não sobe", então a flag fica desligada.

## Arquivos

| Arquivo | Modo | O que mostra |
| -- | -- | -- |
| `tool-list-*.json` | `tool-list` | Lista de ferramentas do evento `init` por argv: `plan_B_equals_plan_A: true`, `plan_B_equals_review: false`. A diferença para o review é `Task`. É a prova decisiva do prefixo |
| `prove-deny-*.json` | `prove-deny`, n=3 | Com a flag, nenhuma chamada a Agent/Task e nenhum transcript de subagente. O modelo informa que as ferramentas não existem na sessão. AC1: **indisponível** |
| `measure-*.json` | `measure`, n=5 por braço | Read e write do 1º request do plan, A contra B, com aquecimento antes de cada amostra |

## Medição A/B (1º request do plan, tokens)

| Braço | n | read mediana (mín–máx) | write mediana (mín–máx) | custo/sessão mediana (máx) |
| -- | -- | -- | -- | -- |
| A: `--disallowedTools` | 5 | 32.223 (13.540–32.387) | 0 (0–18.847) | 0,0066 USD (0,154) |
| B: `permissions.deny` | 5 | 32.387 (14.122–32.387) | 0 (0–18.200) | 0,0066 USD (0,149) |

O aquecimento (argv do review) lê cerca de 37,5 k. O plan, nos dois braços, lê cerca de 32,3 k:
os 5 k de diferença são a definição da ferramenta de subagente, que falta nos dois.

**Viés conhecido:** o cache tem TTL de 1 h (todos os writes são `ephemeral_1h`). Uma sessão do
plan lê o cache deixado por sessões anteriores **do mesmo braço**, e por isso os reads altos não
provam que o prefixo é compartilhado com outros nós. No watcher, o plan é raro (23 de 685
sessões na amostra da PRI-191), então esse reuso entre sessões do plan não representa a
operação. Por isso a conclusão vem do `tool-list`, não desta tabela. A cada braço, a 1ª sessão
fria lê cerca de 13,5 k e grava cerca de 18,5 k.

O read de 27.165 da PRI-206 P0b (2.1.319) pode ter o mesmo viés, ou a semântica do deny pode
ter mudado entre as versões. Isso é UNKNOWN.

## Fora desta evidência

- Os tokens de uma run real do nó plan no watcher e no consumidor: UNKNOWN (o prompt aqui é um
  stub).
- As runs pareadas do AC4 não foram feitas: o piloto não foi autorizado e o resultado acima o
  torna sem objeto.
