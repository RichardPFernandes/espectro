# Baseline arquitetural de Prisma

## 1. Identidade, fontes e destino
[Manifest F31](https://linear.app/prisma-app/document/f31-phase-manifest-planning-development-handoff-297239f0b065) é índice de recuperação. [Instrução do primeiro ciclo](https://linear.app/prisma-app/document/f31-instrucao-de-entrada-para-desenvolvimento-approved-802e843abece) é a instrução aprovada de entrada; sua captura de diagnóstico é histórica.

| Objeto | Identidade / estado |
| -- | -- |
| Freeze | D-F30-01 opção A, Richard; PRI-52 Done |
| Handoff anterior | 5fd38623-3b60-406f-ab90-89ca31e700e2; PASS 56d310f5-cefc-4a6d-8014-f2e29ee7cd58 anterior a Done |
| Roadmap congelado | 1791252575-7603, 2.294.424 bytes; SHA-256 2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96 |
| Fonte local | Backup final recuperado na F30 e tamanho/hash reconferidos na F31; sem certificar latest online |
| Estado/decisões | Linear e Ledger lógico: índice 90b7b08b…; D 0cb025a0…; U 158c56ff…; R bc7d0b41… |
| Implementação/permanência técnica | Git privado RichardPFernandes/prisma; runtime/CI para provas executadas |
| Destino entregue | Repo privado Prisma desde PRI-59; app-back consumidor fixado em a50ff9f na PRI-63 |
| Caminho relacionado | /Users/richardfernandes/Workspace/app-back: origem identificada na F23 e presente na leitura F31 |
| Captura limitada de metadata | Git root app-back; HEAD a1ac43307cc5f275caf5a70ad3068c9af099b127; 5 modificados e 32 untracked no instante observado |
| Limite da captura | HEAD + contagens não identificam toda árvore suja, release, cobertura ou runtime. Não promovem UNK-F21-001/BND-001 a RESOLVED |

Leitura dirigida no app-back: AGENTS.md, memory/project.yaml, buscas em memory/spec/index.yaml (módulo orquestrador-dashboard), .graph/graph.yaml, trechos AC-IDs de fetch-ticket e existência de arquivos relevantes. Índice descreve orquestração como ferramenta local em construção, distinta dos domínios TMS. Regras do host: preservar código/estado existente, não expor secrets, seguir Plan→Implement→Review→Test→Verify→Commit quando execução autorizada; escrita permanente em memory pelo Commit. Essa leitura F31 não executou workflow ou efeitos. As provas posteriores de extração e cutover estão separadas no [handoff](../extraction-handoff.md); não retrocertificam a captura F31.

Fontes aprovadas reabertas por necessidade: F23 (271a011c-dd34-4ef7-8106-87c83aa953a9), F24 (df36bb1b-2fc1-4925-a65c-37fb67ada1f3), F25 (83f567a9-50ab-4c31-800c-9cc19d87dc91), F22 (28bf8fb6-6d83-42e2-90fd-7956e3a4f8e7), Approved/Evidence F30, Ledger e Handoff. Leituras F23/F24/F25 foram dirigidas às condições/obrigações, sem alegar auditoria completa de todo material histórico. Roadmap: gv-slices/freeze e task61 reconferidos; governança/gates/critical/ladder do pacote F30 transportados com os mesmos limites.

## 2. O que o desenvolvedor recebe
1. Baseline congelada com identidade exata e fontes navegáveis.
2. [Condições de entrada por atividade](residual-gates.md), separadas de estados UNKNOWN.
3. [Entrada de desenvolvimento](development-entry.md) e regra de escolher delta real.
4. [Obrigações de validação](validation-map.md), separadas das provas executadas.
5. [Documentação permanente e evidências](../extraction-handoff.md), com fronteira Linear/Git.
6. Instrução do primeiro ciclo (8bd82b86-d6e1-4bb9-8865-280eb54fb572) e formato de resultado.
7. [Carry-forwards e regras de mudança](residual-gates.md), sem delegar a F31 toda resolução pendente.

Referências por capacidade:
- Core/profile/projeto, APP-01/02 e single-writer: HD-001/002 e HD-AF-005/006/072/073; mapa DOM-001 é associação, não owner novo.
- Execução: S1=Run HD008; S2 subject/owner HD013; S3 idempotência no receptor HD014; binding/sucessora HD012/076.
- Gate/Policy/continuação: DOM-03 writer e Decision; DOM-05 autoriza; DOM-02 aplica consequência; timeout não aprova rollback HD018/020/022.
- Contexto/evidência: DOM-06 writer/custódia/aceitação de Context Record HD077; APP A6 compõe/A7 lê; DOM-04 validade/derivação.
- Fatos/effects: estado dos owners/journals; consumers obrigatórios; OUTCOME_UNKNOWN e obligation distinta de outcome.
- Trust/classificação/lifecycle: HD053…071, sem relaxamento silencioso/self-grant; direitos atuais, isolamento e resolvabilidade.
- Economia: D-F20-13/14 e XC-F-001/002/003 PARTIALLY_COVERED, sem custo/causalidade inventados.

Formulas integrais no Ledger/Approved Documents prevalecem sobre a síntese. A aprovação do pacote não promove todos os contratos residuais a completos nem certifica o AS-IS.

## Mudança de arquitetura

D-F30-01 fixa a baseline reconciliada. Mudança estrutural precisa de evidência/Architecture Change Candidate/decisão/reconciliação; documentação ou AS-IS não alteram contratos por inferência. UNKNOWNs e mecanismos adiados continuam nos registros canônicos.


Derivado do draft F31 de mesmo nome, adaptado na PRI-64 em 2026-10-08. Origem e hash estão em [provenance/pri-64-documentation.json](../../provenance/pri-64-documentation.json). Esta síntese preserva os contratos; decisões/status correntes ficam no Linear.
