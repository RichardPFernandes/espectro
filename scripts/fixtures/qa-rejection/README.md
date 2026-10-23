# C0 — caracterização sintética das recusas QA (PRI-221)

Todos os valores foram inventados para este teste: IDs 990xxx, pessoas fictícias,
formas geométricas, datas fixas e marcadores sem credenciais. Nenhum arquivo do
consumidor, ticket, nota QA ou configuração real foi usado como fixture.

Baseline caracterizada: `fd9f08ed017194642525c87a1aede11e5985cc48`. Destino:
este diretório e `scripts/lib/qa-rejection-current-golden.test.js`. Não há
transporte de código do consumidor nem alteração em produção, schema ou gates.

## Conteúdo e cobertura

| Insumo | Golden atual |
| --- | --- |
| `current.json`: journals `own`, `none`, `bounce` | Nota própria vence comentário posterior; sem nota retorna null; bounce da correção #45 retorna ID/data da devolução 8→2, não da entrada em 13. |
| `between_polls` | Há duas novas entradas em 13 depois da primeira; fetch direto seleciona a última, mas o sync não consulta journals se o status entre polls for igual. |
| `transport` | Fonte indisponível, HTTP 401 e TimeoutError viram null; fetch direto se recupera. O sync grava fallback de `ticket.updated_on` e não recupera a nota enquanto o status não mudar. Timeout é lançado pelo stub, sem espera real. |
| `legacy_unique`, `legacy_ambiguous` + state `legacy` | Insumos para futura qualidade DEGRADED: uma transição coincidente ou duas no mesmo segundo. Hoje não existe promoção/chave/identity_quality; sync pula status igual e qa-cycles deduplica por data mesmo quando a identidade é ambígua. C0 não introduz campos futuros. |
| State `retry` | Consumo move o run arquivado, mantém task/execution/count, limpa churn, reabre implement, remove sinal e instrui só o primeiro despacho; destino ocupado não é sobrescrito. Exceção legada sem spec preservada. |
| `adversarial.json` | Oito notas: aprovação, SQL, troca de alvo, leitura de env/config, FACT falso, JSON extra, falso Watcher e ferramenta. `contextBlock` apenas cita o texto literalmente e o parser o recupera. |

`golden.json` é o oráculo versionado, escrito explicitamente a partir do fluxo
atual. O teste importa as funções de produção, sem extrair/reimplementar seu
algoritmo e sem criar seam. As únicas datas variáveis (`detected_at`) são
validadas e retiradas da comparação; identidade, timestamps de fonte e controles
permanecem exatos. Não há chamada real à rede: `fetch` é substituído por stub
estrito que só admite os GETs sintéticos esperados. Não se inicia tick/agente.

## Árvore de sentinelas reutilizável

`require('./sentinel-tree.cjs').materialize(rootTemporario)` materializa os paths
relativos de `adversarial.json`, incluindo `.env`, HOME sintético/config, state e
nota de outro run, arquivo fora da allowlist ao lado da spec, symlink real para
alvo externo à spec e arquivo grande de 128 KiB. O teste verifica o tipo/realpath,
conteúdo e tamanho. Não modifica HOME do operador. `test_limit_bytes` é só
limite sintético para demonstrar arquivo excedente, não política do produto.

Não há coletor, runner, diagnóstico ou exportador em C0. Portanto os testes de
sentinelas/corpus NÃO certificam ausência no pack/prompt/transcript/export,
resistência à injeção, promoção DEGRADED ou outros ACs C1+. Esses testes pertencem
às fatias correspondentes, após as liberações governadas.

## Execução

Receita oficial: `docs/runbook.md`, seção Testes dos pacotes. O teste já entra
em `lib/*.test.js` do manifest de scripts, que não precisa mudar. Para execução
dirigida, com o mesmo ambiente isolado da receita:

```sh
node harness/run-tests.js scripts lib/qa-rejection-current-golden.test.js
```

Fornecer REPO_PATH/PRISMA_ROOT absolutos, HOME/TMPDIR sintéticos e o preload
`harness/loopback-only.cjs`, como na receita. Os diretórios gerados por mkdtemp
são removidos ao terminar; nenhum estado operacional do projeto é usado.
