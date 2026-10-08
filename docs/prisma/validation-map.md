# Validação da mudança

## 6. Validação transportada
Todas as obrigações abaixo são aprovadas na F25. Na captura F31, evidência executada de produto não foi recuperada: UNKNOWN/UNVERIFIED nesse recorte. As provas posteriores delimitadas estão no [handoff](../extraction-handoff.md). Cenário sintético GOVENG F30 não substitui esses testes.

| Obrigações | Propriedade / resultado exigido | Evidência necessária na mudança dependente |
| -- | -- | -- |
| O1/O14/O15 | Writer único; S2; S3 no receptor | Escrita por owner/subject, falhas intercaladas, single-winner e replay recupera desfecho sem atomicidade global |
| O2/O16 | Binding/contexto fixos e aceitação antes do início | Refs entregues/revalidação atual, ordem durável/Context Record e falha que impede início |
| O3/O12/O17 | UNKNOWN preservado; view/ACK sem autoridade; compatibilidade | Casos missing/STALE/incompatível no producer/consumer, sem zero/sucesso/upgrade automático |
| O4/O5/O6 | Legado/migração/effects/observável atual | Antes/depois, legacy≠backfill, crash/replay/reconciliação sem duplicar efeito, baseline autorizada |
| O7/O8 | Corte/gates/contratos mínimos | Critério por dependência; stub somente permitido, sem satisfação integral presumida |
| O9/O10/O11 | Enforcement/secrets/direitos/lifecycle | Caminho governado, canais exercitados, admissibilidade desde primeira retenção; canário não prova universalidade |
| O13/O18 | Versões de comparação e autoridade da evidência | Refs aplicáveis/diferenças explícitas; DOM04 validade, DOM02 transição; output não substitui owner |
| O19/O20/O21 | Exposição/contaminação, fidelidade/isolamento e incompletude | Case/expected/grader/fixture/contexto versionados, limites por finalidade, zero efeito, PARTIAL/UNKNOWN preservados |
| P1/P2 | Consumo atribuível/completo e ausência não zero | Reconciliação por provider/unidade; soma conhecida+contagem desconhecida/completude; pricing original |
| P3/P4 | Limites condicionais e decomposição dependências | Contrato/triggers vigentes; sem quota/teto/paralelismo novo; S1 preservado |
| P5/P6/P7 | Integração, regressão e eficiência por resultado | População/N/missing/versões/qualidade/risco/custo, custos falhas/Eval/Shadow explícitos, sem causalidade presumida |

Cobertura: O1–O21/P1–P7 transportados uma vez nesta síntese. Nenhum N, KPI, pricing, limiar, fórmula ou amostra escolhido. PASS em nível não prova o seguinte; E2E sintético não prova real-world, segurança universal ou causalidade. Selecionar testes pelo impacto/delta e critérios da fonte, não executar suíte global por repetição do planejamento.

## Proveniência

F25 Approved Document 83f567a9-50ab-4c31-800c-9cc19d87dc91 é a fonte integral das obrigações. Esta síntese não prova execução nem certifica cobertura universal. Cada entrega deve identificar resultados e artefatos concretos dos testes adequados à mudança, mantendo UNKNOWN onde não demonstrado.


Derivado do draft F31 de mesmo nome, adaptado na PRI-64 em 2026-10-08. Origem e hash estão em [provenance/pri-64-documentation.json](../../provenance/pri-64-documentation.json). Esta síntese preserva os contratos; decisões/status correntes ficam no Linear.
