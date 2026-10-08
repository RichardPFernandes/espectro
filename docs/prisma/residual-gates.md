# Condições e resíduos por atividade

## 4. Condições por atividade
Uma condição faltante impede a atividade dependente; não torna todo planejamento FAIL. UNKNOWN não é TODO nem pode ser tratado como satisfeito.

| Atividade | Condição de entrada / saída verificável | Resíduo preservado |
| -- | -- | -- |
| Diagnóstico de primeiro delta | Fonte/escopo/read-only e checkout identificados; registrar árvore relevante e cobertura antes de claim | F21-001; metadata limitada nesta fase não substitui baseline completa |
| Preparar mudança de código | Arquivos/subject, autoridade, A1–A7, plano/ACs e evidência anterior delimitados; autorização de execução específica | BND001 quando há extração/reuso, regras do host e alterações alheias |
| AC-IDs/Spec/Plan | Requisito task61 confrontado com o atual; nenhum requisito inventado/texto duplicado; legado preservado | Não inferir cumprimento pelos arquivos encontrados; O1/3/6/7/12/18 |
| Commit local/idempotência/Run | S2/S3 por owner/subject e binding fixo; erro/concorrência/CKU e outcome provados no caminho | HD009; CT004/DP002; mudança material exige sucessora |
| Contexto mandatório | Context Record imutável aceito por DOM06 antes de início protegido, fidelidade/falha correlacionada | AR001/F20A001 parciais, sem writer novo |
| Migração de registros | Contrato por owner/auth/CAS, imutáveis e equivalência antes/depois; legacy handling distinto de schema/backfill | F23-001 OPEN; não migrar por existência de task80 |
| Efeito/recovery/rollback | Authority atual, journal/idempotência/reconciliação e Gate humano aplicável; timeout não aprova | RCV003/ST005/DIV-F27-001 e HD009 |
| Composição/compatibilidade | Versões aplicáveis/snapshot consistente e desfecho admissível de desconhecido/incompatível | CP005/WF001 distintos, F20C001/F20B residuais |
| Provider/routing/portabilidade | HARD/CONTRACT/gates/triggers satisfeitos; snapshot/eligibility atuais; R1 decidido quando caminho depender | CP002/009; DRAINING e segundo provider não escolhidos |
| Corpus/Eval/Shadow | Custodiantes/contratos/direitos/lifecycle e scope isolado; SIDE_EFFECT=DENY; propósito/desenho/versions declarados | IE001 lógico concreto, IE002…007, F20A002, SEC/DL |
| Dados/retention/export | Classificação/trust/lineage, origem/destino, obrigações aplicáveis e autorização do dono | DL001/002, SEC005/006, HD005; sem retenção/delete universal |
| Promover os três cards F005 | Conferir U/R2/R8/gates/necessidade real; PROMOTABLE não prova resolução | F30-F-005 OPEN; sem owner/direção inventados |
| Promover documentação ao Git | Conteúdo aprovado, destino/convenções/checkouts e direitos delimitados; diff restrito, readback, commit rastreável | PRI-64 documenta o recorte entregue; preservar alterações alheias e registrar readback |
| Declarar READY/release | Validation Ladder e condições reais do milestone exercitadas e evidenciadas | BaseMP00/R7, MP13/amostra e runtime/CI não certificados |

Destinos/facetas dos UNKNOWNs permanecem nos registros correntes. Nenhum owner físico/papel/tempo/teto foi escolhido. Se o próximo delta exigir decisão arquitetural, classificar finding e candidato; se a condição for apenas identidade/cobertura/evidência operacional, não inventar novo UNKNOWN arquitetural.

## 8. Carry-forwards e achados
| ID | Classe | Disposition proposta |
| -- | -- | -- |
| Observação 1 | ACTION_REQUIRED carry-forward | F21-F-007/UNK-F21-001: antes de execução, delimitar CURRENT por árvore/cobertura/provas; metadata parcial é evidência adicional, sem fechar o objeto |
| Observação 2 | INFORMATIONAL | Host app-back identificado; paths/equivalentes ACs encontrados; primeiro ciclo passa a diagnóstico/delta, sem repetir task61 por inferência |
| Observação 3 | ACTION_REQUIRED dedup | F30-F-005 permanece na entrada canônica; guarda transportada ao handoff; não criar nova pendência independente |
| Observação 4 | INFORMATIONAL | F31 encerrou AF; PRI-64 promove documentação no Git, sem F32 ou novo trabalho iniciado por inferência |

RRCs/aliases/adiamentos F29 preservados; F31 registra 127 RRC (125 herdados + RRC-F31-001/002 NOT APPLIED), 134 linhas UNKNOWN e 57 DIV. A PRI-64 não atualiza esses registries. DIV-F27-001/IE-002/F20B-002/SEC-001 e R1–R9 seguem suas facetas. XC-F-001/002/003 PARTIALLY_COVERED. Nenhum finding arquitetural novo independente demonstrado; comparação integral CURRENT não foi realizada, logo não há afirmação de conformidade/ausência universal de conflito.

Reabertura pós-Freeze: evidência SECURITY_CRITICAL, DATA_LOSS/STATE_CORRUPTION, IMPLEMENTATION_BLOCKER, OBSERVED_REAL_WORLD_NEED ou FAILED_EVAL/FAILED_E2E que exija alteração arquitetural. Candidate com razão, evidência, runs afetadas, limitação, impossibilidade no desenho atual, benefício, componentes, risco e validação. Decisão humana/reconciliação, sem nova engine para governança.

## Regra de atualização

Não usar esta tabela como um segundo Ledger de status. Atualizar decisão/findings/UNKNOWNs nos registros canônicos; nesta documentação conservar a condição arquitetural e a referência à origem. Qualquer mudança semântica passa por governança e revisão.


Derivado do draft F31 de mesmo nome, adaptado na PRI-64 em 2026-10-08. Origem e hash estão em [provenance/pri-64-documentation.json](../../provenance/pri-64-documentation.json). Esta síntese preserva os contratos; decisões/status correntes ficam no Linear.
