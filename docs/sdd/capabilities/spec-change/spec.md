# NÃO AUTORITATIVO — ensaio

Capability: `cap:prisma:spec-change`  
Status: **Candidate**  
Owner: Richard (PRI-83; autorização de autoria no briefing P1)  
Origem: PRI-174 / PRI-132; baseline de código `862981516c639d12811b308673165746472aef9b`.  
Aliases documentais: `task-65`, `task-73`, `task-74`, `task-75`.

Este arquivo é extração candidata de contratos existentes. Não aprova RNs, não atribui cap_version/cap_hash, não ativa capability e não é entrada de leitor de runtime. Catálogo é índice derivado. Não há log oficial. O ensaio não reabre as tasks legadas e não certifica a totalidade delas.

## Objetivo

Tornar revisável a cadeia requisito → contrato versionado → código → teste, preservando decisão humana de mudança, identidade do contrato e limites de evidência. Usuários: autores de spec e agentes do fluxo SDD, aprovador humano, Review/Verify e consumidores autorizados de provenance.

## Escopo

SPEC_CHANGE da spec do run, HASH_SCOPE, versionamento e carimbo dos derivados, validade e provenance de AC. INC/versionamento/ativação de capability são extensões propostas em PRI-132 e aparecem somente no exemplo de evidência externo ao runtime. Regras de lifecycle reconciliadas no Roadmap qualificam documentos de implementação anteriores.

Fontes primárias do ensaio: os documentos indicados por RN no commit fixado e Roadmap `1791252575-7603` (SHA-256 `2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96`). Os documentos trazem a ressalva de extração PRI-60: referências históricas não configuram consumidor nem autorizam recovery. Não lhes é atribuída nova aprovação arquitetural. O recibo e os hashes das fontes estão no pacote P1.

## Regras de Negócio — extração candidata

Cada bloco tem ID permanente proposto e source_refs versionadas. IDs não se confundem com ACs de change, não são reciclados e não deduplicam AC-01. Nenhuma relação introduces/modifies/retires é inventada: autoria histórica da change para estes RNs é UNKNOWN. As source_refs documentam origem, sem conferir conformidade ao código.

### RN-01 — Classificar alteração funcional e pausar para decisão humana

ID: `cap:prisma:spec-change#RN-01`  
Status no ensaio: **Candidate**

Decisão que altera requisito, reduz AC ou muda comportamento funcional é SPEC_CHANGE e não pode ser aprovada pelo próprio Implement. A proposta é auditável e pausa o pipeline; rejeição mantém a spec e a pausa. TECHNICAL_DECISION e SPEC_CLARIFICATION só seguem quando compatíveis com o comportamento e os ACs.

source_refs: consulte o bloco deste RN em Referências.

Limite: Classificação e pausa local encontradas; prova ponta a ponta e autoridade reconciliada não verificadas.

### RN-02 — Distinguir autoria inicial e versão da spec do run

ID: `cap:prisma:spec-change#RN-02`  
Status no ensaio: **Candidate**

No fluxo documentado, fetch-ticket inicializa spec draft v1 e Plan sela a versão inicial com o hash contratual preenchido. Autoria inicial antes da selagem não é SPEC_CHANGE. Essa versão é da spec do run, não cap_version.

source_refs: consulte o bloco deste RN em Referências.

Limite: Fluxo existente identificado; não cria versão aprovada da capability.

### RN-03 — Calcular o contrato com HASH_SCOPE fixado

ID: `cap:prisma:spec-change#RN-03`  
Status no ensaio: **Candidate**

O hash contratual usa contract_sections_v1 e a função central spec-hash.js. O escopo inclui ACs, objetivo, escopo, regras de negócio, comportamento esperado, solução legada e restrições. Contexto, frontmatter e histórico ficam fora. Escopo já usado não é editado: novo escopo recebe novo id, preservando o escopo registrado nos runs.

source_refs: consulte o bloco deste RN em Referências.

Limite: Presença estática do algoritmo e casos de teste; igualdade entre todos os callers não executada.

### RN-04 — Incrementar versão somente por SPEC_CHANGE aprovada com alteração de hash

ID: `cap:prisma:spec-change#RN-04`  
Status no ensaio: **Candidate**

SPEC_CHANGE aprovada que altera HASH_SCOPE incrementa spec_version e acrescenta entrada com versão, hash, razão, approval_ref e diff_summary. Sem alteração do hash, a versão é mantida. O changelog preserva entradas anteriores, recusa sequência inválida e não sobrescreve arquivo ilegível.

source_refs: consulte o bloco deste RN em Referências.

Limite: Aprovação da SC do run não serve como Decision de INC.

### RN-06 — Atribuir evidências ao par de versão/hash realmente usado

ID: `cap:prisma:spec-change#RN-06`  
Status no ensaio: **Candidate**

Plan, Review, Test, Verify e PR registram a spec utilizada. Se o hash corrente não corresponde à versão registrada, o artefato usa spec_version null e alerta mid-run; não inventa versão. Inconsistência de versão com mesmo hash e matriz de versão divergente recebem as falhas descritas na fonte.

source_refs: consulte o bloco deste RN em Referências.

Limite: Carimbo não demonstra conformidade nem autoriza rebind.

### RN-07 — Preservar runs legados sem migração ou versão inventada

ID: `cap:prisma:spec-change#RN-07`  
Status no ensaio: **Candidate**

Bloco spec ausente ou malformado não é convertido retroativamente em versão válida. Leitores degradam para null/UNVERSIONED, preservando o algoritmo e o estado legado. A ausência de checagem de versão não dispensa a validade da evidência, tratada em RN-11.

source_refs: consulte o bloco deste RN em Referências.

Limite: Compatibilidade de leitura não implica evidence aceitável.

### RN-08 — Reentrar por Plan como regra SDD após SPEC_CHANGE aprovada

ID: `cap:prisma:spec-change#RN-08`  
Status no ensaio: **Candidate**

SPEC_CHANGE aprovada requer reentrada por Plan e reavaliação dos derivados, inclusive quando o hash não muda. SDD-RULE-001 é regra do Profile SDD, não etapa obrigatória universal do Core. Isso não autoriza continuidade da mesma run sob Work Contract materialmente superado (RN-10).

source_refs: consulte o bloco deste RN em Referências.

Limite: Testes locais de node=plan não cobrem a sucessora nem validam SDD como regra universal.

### RN-09 — Avaliar validade contra identidade/versão do contrato e preservar avaliações

ID: `cap:prisma:spec-change#RN-09`  
Status no ensaio: **Candidate**

Versão avaliada distinta da vigente não é VALID, mesmo sem entrega do evento contract.changed. STALE é condição derivável; marcador INVALIDATED de derivado e terminal INVALIDATED de run têm sujeitos distintos. Nova avaliação preserva a anterior como histórico; UNKNOWN não vira VALID. Sem change-set suficiente a invalidação é conservadora.

source_refs: consulte o bloco deste RN em Referências.

Limite: Código local cobre partes da invalidação; preservação completa de avaliações e contrato DOM-04 não comprovados. A reconciliação Roadmap qualifica o texto extraído do doc.

### RN-10 — Preservar binding e usar run sucessora na mudança material

ID: `cap:prisma:spec-change#RN-10`  
Status no ensaio: **Candidate**

Binding set da run é imutável. Mudança material do Work Contract invalida terminalmente a run corrente; continuidade exige nova admissão/run sucessora com lineage e novo binding. Resultado de tentativa em voo sob contrato superado não autoriza avanço ou commit da mesma run. Nova Workflow Definition/version isolada não reinterpreta nem invalida uma run bound.

source_refs: consulte o bloco deste RN em Referências.

Limite: HD-009/UNK-PRI-004 e UNK-ARCH-010 preservados. Não escolher cancelamento, preempção ou reentrada; docs locais não são autoridade para rebind.

### RN-11 — Recusar evidência STALE/UNKNOWN e transição pendente

ID: `cap:prisma:spec-change#RN-11`  
Status no ensaio: **Candidate**

Verify recusa evidência STALE ou UNKNOWN; legado sem spec_hash não ganha hash retroativo. Verify e Commit recusam PENDING_SPEC_INVALIDATION. Review alerta validade insuficiente sem virar portão de aceitação. Replay não ressuscita evidência antiga nem altera o run original.

source_refs: consulte o bloco deste RN em Referências.

Limite: Guard local não substitui elegibilidade PHI, admissão ou gate reconciliado.

### RN-12 — Identificar AC por ticket e AC-ID

ID: `cap:prisma:spec-change#RN-12`  
Status no ensaio: **Candidate**

A identidade legada é (ticket_id, ac_id): dois AC-01 de tickets distintos permanecem distintos. O log é por ticket e a consulta ambígua não escolhe um candidato automaticamente.

source_refs: consulte o bloco deste RN em Referências.

Limite: RN não introduz IDs PRI-* nos leitores numéricos atuais nem deduplica AC-01.

### RN-13 — Manter origem não demonstrável como UNKNOWN

ID: `cap:prisma:spec-change#RN-13`  
Status no ensaio: **Candidate**

Origem de AC exige referência persistida; texto ou ausência de outra fonte não demonstram autoria humana. AGENT_DRAFT_APPROVED conserva autoria AGENT e autoridade HUMAN_APPROVED. UNKNOWN de provenance não reprova nó por si só; não confundir com UNKNOWN de validade da evidência.

source_refs: consulte o bloco deste RN em Referências.

Limite: Sem reconstrução de origem por LLM, similaridade textual ou timestamp.

### RN-14 — Preservar cadeia de provenance append-only e projeção derivada

ID: `cap:prisma:spec-change#RN-14`  
Status no ensaio: **Candidate**

Eventos de provenance não são alterados nem removidos. Append do mesmo event_id é no-op; log ilegível não é sobrescrito. Log é a fonte de provenance e Registry é projeção reconstruível; CLARIFICATION e MODIFICATION não apagam ORIGIN.

source_refs: consulte o bloco deste RN em Referências.

Limite: Não converter o log de AC em log oficial de capability. Precedência global e mudanças de writers continuam governadas.

### RN-15 — Vincular provenance da SPEC_CHANGE a referências estruturadas

ID: `cap:prisma:spec-change#RN-15`  
Status no ensaio: **Candidate**

A aprovação registra os ACs tocados e preserva separadamente o journal da proposta e o journal de aprovação. HUMAN_CLARIFICATION só surge quando human_input_refs é validado contra interpretações persistidas; mera menção no rationale não produz vínculo. Rejeição não grava provenance.

source_refs: consulte o bloco deste RN em Referências.

Limite: Captura existente não resolve reconciliação completa de fontes/precedência da task-74.

### RN-16 — Não transportar conteúdo ou credenciais nas referências de provenance

ID: `cap:prisma:spec-change#RN-16`  
Status no ensaio: **Candidate**

Provenance nova guarda referências e não duplica texto do AC. Referência com conteúdo, credencial ou string acima do limite documentado de 200 caracteres é recusada sem gravação. Resposta de API passa pela redação documentada.

source_refs: consulte o bloco deste RN em Referências.

Limite: Levantamento estático não prova zero vazamento em todas as superfícies.

## UNKNOWNs e precedência não resolvida

### RN-05 — Registrar rebaseline sem inventar incremento de versão

ID: `cap:prisma:spec-change#RN-05`  
Status no ensaio: **UNKNOWN — fora da extração contratual candidata**

A documentação existente descreve mudança de contrato em ponto de baseline sem SPEC_CHANGE como rebaseline: preserva o número de versão, registra novo hash e diferenças em rebaselines[].

source_refs: consulte o bloco deste RN em Referências.

Limite: UNKNOWN de precedência: permissão para continuar no mesmo run não é derivada deste comportamento. Mudança material depende do lifecycle/sucessora reconciliado; este RN fica fora da extração contratual candidata.

- U-01: documentos locais descrevem mutação/retorno ao Plan no mesmo run; o Roadmap reconciliado (RN-10) exige sucessora na mudança material. Não se aprova rebind ou migração de histórico por esta extração.
- U-02: docs/ac-provenance.md §§Fontes/Source Roles/Registry Storage divergem de expectativas históricas de task-74 (captura no fetch-ticket, precedência global e Registry). Este ensaio não decide a reconciliação integral; RN-12..16 são extração documental delimitada, não aceite da task.
- U-03: granularidade concreta, preempção/cancelamento e reentrada permanecem HD-009/UNK-PRI-004; UNK-ARCH-010 SOURCE_UNAVAILABLE não é reconstruído.
- U-04: sem esquema operacional de RN/INC/log implementado ou writer reconciliado. A primeira operação protegida exige RRC-SDD-001/002/003 reconciliados, writer definido/implementado/revisado e Gate/Decision aplicável.
- U-05: DS aprovadas na descrição da PRI-132 autorizam Candidate; não tornam este texto Approved/Active. RRC-F31-001/002 permanecem NOT APPLIED.

## Fluxos e critérios de aceite do ensaio

1. RN de fonte existente possui doc+seção+commit ou card+versão/hash; precedência não decidida permanece UNKNOWN, fora das regras candidatas.
2. Mudança funcional é classificada e submetida à decisão humana; hash/versão de run não são confundidos com versão de capability.
3. Artefato sem evidência válida não comprova contrato; aprovação da spec não comprova implementação.
4. Matriz externa cobre os 16 IDs, inclusive RN-05 UNKNOWN, com limites de cobertura; toda conformidade permanece UNVERIFIED.
5. Exemplos externos percorrem v1, primeira ativação, geração, rebase com nova Decision, replay e conflitos, exclusivamente no papel.
6. Revisão independente do Arquiteto (Claude) e handoff validado antecedem conclusão integral do P1.

## Referências e limites

- Matriz, log-exemplo, lições e recibos: pacote `prisma-evidence/sdd-2026-10-22/p1/`, fora da fonte normativa e do runtime.
- `docs/spec-versioning.md`, `docs/ac-provenance.md`, `docs/dependency-invalidation.md`: consultar na revisão fixada de cada source_ref.
- Modelo do ensaio: proposal-sdd-capability.md §§3.2/3.3/4/5.4 e pilots.md §P1 (hashes no manifesto do pacote); decisões posteriores na PRI-132 prevalecem sobre cabeçalhos antigos NOT APPROVED da proposta.
- API Linear/IDs RN/cap/chg permanecem documentais. Leitores atuais com ticket numérico não são adaptados.

## Referências — source_refs versionadas por RN

Metadados de origem fora das seções contratuais do HASH_SCOPE. A localização não lhes confere autoridade de writer.

### cap:prisma:spec-change#RN-01

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Ciclo de vida"
  },
  {
    "kind": "roadmap_card",
    "id": "task-65",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "Prompt para o ciclo /plan — TIPOS DE DECISÃO / FLUXO / REVIEW"
  }
]
```

### cap:prisma:spec-change#RN-02

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Ciclo de vida; Por que a v1 só é selada no /plan"
  },
  {
    "kind": "roadmap_card",
    "id": "task-73",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-01; Prompt para o ciclo /plan — fluxo de versão inicial"
  }
]
```

### cap:prisma:spec-change#RN-03

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "HASH_SCOPE"
  },
  {
    "kind": "roadmap_card",
    "id": "task-73",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-02; Prompt para o ciclo /plan — HASH_SCOPE"
  }
]
```

### cap:prisma:spec-change#RN-04

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Ciclo de vida; Formatos / memory/spec/<ticket>-spec-changelog.json"
  },
  {
    "kind": "roadmap_card",
    "id": "task-73",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-03; AC-04"
  }
]
```

### cap:prisma:spec-change#RN-06

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Artefatos derivados; Quem escreve cada campo, e quando"
  },
  {
    "kind": "roadmap_card",
    "id": "task-73",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-05"
  }
]
```

### cap:prisma:spec-change#RN-07

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Runs legados (unversioned)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-73",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-06"
  }
]
```

### cap:prisma:spec-change#RN-08

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/dependency-invalidation.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "3. Lógica de invalidação centralizada; 8. Mudanças de comportamento"
  },
  {
    "kind": "roadmap_card",
    "id": "task-65",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "Prompt para o ciclo /plan — Reconciliação F29 / RRC-PRI-003 / D-F29-L5-03"
  }
]
```

### cap:prisma:spec-change#RN-09

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/dependency-invalidation.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "2. Estados de validade; 7. Autoridade de validade × mecanismos de suporte"
  },
  {
    "kind": "roadmap_card",
    "id": "task-75",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "Prompt para o ciclo /plan — Reconciliação F29 / RRC-ST-006 / D-F29-L1-25"
  }
]
```

### cap:prisma:spec-change#RN-10

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-75",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "Prompt para o ciclo /plan — Reconciliação F29 / RRC-ST-003 / D-F29-L1-22 (APLICAR); task-65 / RRC-PRI-003"
  }
]
```

### cap:prisma:spec-change#RN-11

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/dependency-invalidation.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "2. Estados de validade; 5. Comportamento por fase / Replay"
  },
  {
    "kind": "roadmap_card",
    "id": "task-75",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-04; AC-05; AC-06; AC-07"
  }
]
```

### cap:prisma:spec-change#RN-12

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/ac-provenance.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Identidade; API"
  },
  {
    "kind": "roadmap_card",
    "id": "task-74",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "Escopo de provenance; equivalência documental não altera ACs legados"
  }
]
```

### cap:prisma:spec-change#RN-13

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/ac-provenance.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Authorship vs Authority; UNKNOWN Semantics; Legacy Strategy"
  },
  {
    "kind": "roadmap_card",
    "id": "task-74",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-05 (escopo de origem; detalhes as-is do doc)"
  }
]
```

### cap:prisma:spec-change#RN-14

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/ac-provenance.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Source Roles; Registry Storage; Append-only / Idempotency"
  },
  {
    "kind": "roadmap_card",
    "id": "task-74",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-04; detalhes de armazenamento as-is do doc"
  }
]
```

### cap:prisma:spec-change#RN-15

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/ac-provenance.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Pontos de captura; SPEC_CHANGE"
  },
  {
    "kind": "roadmap_card",
    "id": "task-74",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-04; detalhes de captura as-is do doc"
  }
]
```

### cap:prisma:spec-change#RN-16

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/ac-provenance.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Objetivo; Declaração explícita (CLI); API"
  },
  {
    "kind": "roadmap_card",
    "id": "task-74",
    "project": "prisma",
    "version": "1791252575-7603",
    "hash": "2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96",
    "locator": "AC-07"
  }
]
```

### cap:prisma:spec-change#RN-05

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/spec-versioning.md",
    "project": "prisma",
    "commit": "862981516c639d12811b308673165746472aef9b",
    "locator": "Mudança de contrato sem SPEC_CHANGE (rebaseline)"
  }
]
```
