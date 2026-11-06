# NÃO AUTORITATIVO — ensaio

Capability: `cap:prisma:concurrency-authority`  
Status: **Candidate**  
Owner: Richard (PRI-83; autoria autorizada pela spec de trabalho P1-b de 06/11/2026)  
Origem: PRI-227 / PRI-174 (R-F2-06 A, D-132-05). Revisão fixada em "Proveniência do ensaio".  
Aliases documentais: `task-76`.

Este arquivo é extração candidata de contratos existentes. Não aprova RNs, não atribui cap_version/cap_hash, não ativa capability e não é entrada de leitor de runtime. O catálogo é índice derivado. Não há log oficial. O ensaio não reabre a task-76 e não certifica a totalidade dela. RRC-SDD-001…005 foram publicados no Roadmap v79 (DR-RRC-SDD-001), mas a H4 não está cumprida e nenhuma operação protegida foi autorizada; RRC-F31-001/002 continuam NOT APPLIED.

## Proveniência do ensaio

Seção fora do HASH_SCOPE. Fixa as revisões citadas pelas source_refs; não lhes dá autoridade.

- Código e documentação da plataforma: commit `d1dfd2bae499911994decf8b340e0aefe18f886e` (main, 05/11/2026).
- Roadmap/Freeze: v80 `1793717367-596d`, SHA-256 `4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560`. A v79 `1793130013-aecc` tem o mesmo texto nos localizadores usados aqui.
- Revisão citada na PRI-227 e na D-132-05: `79ccdcc` e Roadmap `1791252575-7603`. Entre `79ccdcc` e `d1dfd2b` a única mudança nos arquivos da capability é `21b088c` (PRI-229).
- Hashes de cada fonte: `prisma-evidence/sdd-2026-10-22/p1b/fontes-p1b.json`.

## Objetivo

Tornar revisável a cadeia requisito → contrato versionado → código → teste das regras que impedem um processo de avançar o estado de um run a partir de leitura obsoleta, de repetir um efeito já aplicado ou de executar em nome de uma posse que perdeu. Usuários: autores e revisores de mudanças no orquestrador, no dashboard e nos agentes que gravam o estado do run; aprovador humano; Review/Verify.

## Escopo

Escrita do estado do run, comparação de expectativas (CAS), versão e campos críticos, posse da execução, idempotência de operações, efeito externo com desfecho incerto, reserva de despacho por ticket, lease de nó, escrita atômica e recuperação de crash, política de retry por tipo de operação e auditoria de conflitos. O contrato congelado de propriedade, atomicidade e identidade de operação (S1/S2/S3) qualifica o mecanismo local.

Fora de escopo: mecanismo físico de serialização (HD-009), atomicidade entre owners ou subjects independentes, Dependency Invalidation, roteamento de modelo, autorização humana e o Diagnosis Record da PRI-181.

## Regras de Negócio — extração candidata

Cada bloco tem ID permanente proposto e source_refs versionadas. IDs não se confundem com ACs de change e não são reciclados. Nenhuma relação introduces/modifies/retires é inventada: a autoria histórica de change para estes RNs é UNKNOWN. As source_refs documentam origem, sem conferir conformidade ao código.

### RN-01 — Posse de execução (S1) é da run e não aprova S2/S3

ID: `cap:prisma:concurrency-authority#RN-01`
Status no ensaio: **Candidate**

A propriedade de execução (S1) tem a run como dimensão. S1 não aprova atomicidade (S2) nem identidade de operação (S3) e não significa uma única run por Work Contract. S1 só é reavaliada se houver paralelismo real de nós da mesma run.

source_refs: consulte o bloco deste RN em Referências.

Limite: o execution_id local é correlação por ciclo; S1 no owner da run não foi demonstrada.

### RN-02 — Transição aprovada é atômica no subject scope de um owner (S2)

ID: `cap:prisma:concurrency-authority#RN-02`
Status no ensaio: **Candidate**

No mesmo subject scope de um owner, a transição aprovada conserva juntos estado, versão, desfecho de idempotência, fato emitido e registros imutáveis necessários à transição. A criação respeita chave de criação única e single-winner.

source_refs: consulte o bloco deste RN em Referências.

Limite: localmente, estado, versão e operações processadas saem na mesma escrita atômica; eventos são campo secundário. Fato emitido no mesmo commit não foi demonstrado. O teste citado na matriz também fixa a divergência U-02 e não é evidência neutra.

### RN-03 — Identidade e desfecho de operação escopados (S3), sem OpId global

ID: `cap:prisma:concurrency-authority#RN-03`
Status no ensaio: **Candidate**

Identidade e desfecho de operação são escopados por owner, subject ou creation-key e tipo de operação. Mesma identidade com mesmo conteúdo reproduz o desfecho; conteúdo diferente é conflito. Não há OpId global.

source_refs: consulte o bloco deste RN em Referências.

Limite: o reconhecimento local compara só a identidade da operação (U-02).

### RN-04 — Consequência entre owners é outra transição, sem commit atômico

ID: `cap:prisma:concurrency-authority#RN-04`
Status no ensaio: **Candidate**

Não há atomicidade entre owners nem entre subjects independentes. Decision registrada não comprova execução nem continuação: aplicar a consequência na run é outra transição, aceita pelo owner da run sob o S2/S3 dele e com autoridade e precondições atuais. Store ou writer compartilhado não transfere ownership.

source_refs: consulte o bloco deste RN em Referências.

Limite: sem localizador de código; um arquivo de estado guarda subjects de vários owners (U-03).

### RN-05 — Writer físico único e CAS não conferem autoridade semântica

ID: `cap:prisma:concurrency-authority#RN-05`
Status no ensaio: **Candidate**

O writer lógico é único por subject e owner. Writer físico único e CAS são mecanismo de concorrência: não tornam a orquestração owner semântico, não unificam a autoridade de Gate e Run e, isolados, não provam exclusividade de todos os caminhos, single-winner ou atomicidade entre owners.

source_refs: consulte o bloco deste RN em Referências.

Limite: qualifica RN-08 a RN-12; a varredura estática cobre só o repositório da plataforma.

### RN-06 — Efeito externo exige verificação vigente antes da emissão

ID: `cap:prisma:concurrency-authority#RN-06`
Status no ensaio: **Candidate**

Antes de emitir efeito externo, o boundary governado verifica a posse vigente da run, a autoridade, o sujeito e o binding atuais, a intenção e a tentativa duráveis, a capability e os limites de dados aplicáveis. Verificar só ao receber o resultado ou ao gravar o estado não basta. execution_id e lease são correlação ou mecanismo de concorrência, não Authority Ref; token superado não autoriza emissão. A emissão externa não integra o commit, e a ambiguidade mantém OUTCOME_UNKNOWN.

source_refs: consulte o bloco deste RN em Referências.

Limite: o caminho local confere versão e hash da spec antes do efeito; posse, autoridade e binding não passam por ele.

### RN-08 — Writer único do estado do run

ID: `cap:prisma:concurrency-authority#RN-08`
Status no ensaio: **Candidate**

Só o writer do estado grava o arquivo de estado do run. Os demais componentes chamam o writer e nunca escrevem o arquivo diretamente.

source_refs: consulte o bloco deste RN em Referências.

Limite: a garantia é estática e local ao repositório; não confere autoridade semântica (RN-05).

### RN-09 — CAS centralizado com campos obrigatórios por operação

ID: `cap:prisma:concurrency-authority#RN-09`
Status no ensaio: **Candidate**

Toda comparação de expectativa (versão, nó, hash da spec, posse, identidade da operação) é feita num único componente de CAS. Cada tipo de operação declara os campos que precisa informar; faltar um deles é erro de programação, nunca aprovação silenciosa.

source_refs: consulte o bloco deste RN em Referências.

Limite: comparações de drift da Dependency Invalidation ficam fora desta regra.

### RN-10 — state_version muda só por campo crítico, uma vez por escrita

ID: `cap:prisma:concurrency-authority#RN-10`
Status no ensaio: **Candidate**

A versão do estado incrementa somente quando muda um campo crítico e conta uma transição por escrita, mesmo com vários campos críticos alterados. Campos secundários, como eventos, custo e heartbeat, nunca incrementam a versão. Só o writer calcula a versão.

source_refs: consulte o bloco deste RN em Referências.

Limite: a lista de campos críticos é decisão do projeto.

### RN-11 — Edição fora do writer conta como versão nova

ID: `cap:prisma:concurrency-authority#RN-11`
Status no ensaio: **Candidate**

Se um campo crítico muda fora do writer, a versão efetiva passa a contar uma transição a mais, e um CAS feito contra a leitura anterior falha.

source_refs: consulte o bloco deste RN em Referências.

Limite: detecção, não prevenção; origem só na documentação local.

### RN-12 — Retry conforme o tipo de operação

ID: `cap:prisma:concurrency-authority#RN-12`
Status no ensaio: **Candidate**

Em conflito de versão, operação de agente relê, confere se ainda faz sentido e tenta uma única vez; falhando de novo, aborta e registra. Operação humana não tem retry automático: recebe conflito com a mensagem fixa de atualizar a tela, nunca erro genérico. Operação de sistema reaplica só o próprio delta sobre o estado atual e recusa se outro processo mudou o mesmo campo crítico de forma diferente.

source_refs: consulte o bloco deste RN em Referências.

Limite: a política cobre conflito de versão; perda de posse segue RN-13.

### RN-13 — Sessão que perdeu a posse não grava nem re-tenta

ID: `cap:prisma:concurrency-authority#RN-13`
Status no ensaio: **Candidate**

A posse da execução nasce no início do ciclo e gira em takeover (retomada, novo QA, replay). Antes de persistir, a sessão relê o estado: posse diferente é conflito de sessão, nada é gravado, o conflito é auditado e a operação não é re-tentada.

source_refs: consulte o bloco deste RN em Referências.

Limite: a posse é correlação de concorrência, não autoridade (RN-06); a rotação em takeover tem origem só local (U-11).

### RN-14 — Operação repetida é reconhecida antes da comparação de versão; conteúdo diferente é conflito

ID: `cap:prisma:concurrency-authority#RN-14`
Status no ensaio: **Candidate**

A identidade da operação processada é registrada na mesma escrita da operação. Mesma identidade com mesmo conteúdo é repetição: a resposta devolve o desfecho e nada é aplicado. Mesma identidade com conteúdo diferente é conflito (RN-03). A conferência de repetição vem antes da comparação de versão, para que a repetição não vire conflito.

source_refs: consulte o bloco deste RN em Referências.

Limite: a implementação local reconhece só pela identidade e trata conteúdo diferente como repetição (U-02); retenção em RN-07.

### RN-15 — Run arquivado não é recriado por escritor obsoleto

ID: `cap:prisma:concurrency-authority#RN-15`
Status no ensaio: **Candidate**

Escrita baseada em leitura de um run que foi arquivado ou movido é conflito, e o run não reaparece. Atualização incremental de um run que não existe mais é "nada a fazer", sem erro. Run novo legítimo nasce só pela criação explícita.

source_refs: consulte o bloco deste RN em Referências.

Limite: origem só na documentação local; não equivale ao requisito de antirressurreição em restore.

### RN-16 — Comentário de aprovação com desfecho incerto é conferido antes de repetir

ID: `cap:prisma:concurrency-authority#RN-16`
Status no ensaio: **Candidate**

No pedido de aprovação feito pelo dashboard, cujo efeito é um comentário no Redmine (destino sem chave de idempotência), a operação usa reserva da identidade, efeito e desfecho. Desfecho incerto ou reserva vencida só é retomado depois de conferir no destino se o efeito já ocorreu. Se a conferência for impossível, não repete às cegas: o resultado fica incerto e a resposta é de falha.

source_refs: consulte o bloco deste RN em Referências.

Limite: vale só para esse fluxo; a generalização para outros efeitos externos não tem fonte (U-12). Exactly-once efetivo só enquanto o destino pode ser lido.

### RN-17 — Despacho de um ticket é reservado entre processos e falha fechado

ID: `cap:prisma:concurrency-authority#RN-17`
Status no ensaio: **Candidate**

Os despachos de um ticket feitos pelo watcher e pelo dashboard passam pela mesma reserva entre processos, mantida da primeira leitura até o despacho ficar visível. Quem chega com a reserva tomada pula. Reserva de dono morto é retomada. Falha ao registrar o despacho em curso aborta o início do agente.

source_refs: consulte o bloco deste RN em Referências.

Limite: sem origem no Roadmap; não é admissão idempotente (U-04). Reserva com hostname diferente conta como dono vivo e exige remoção manual.

### RN-18 — Carimbo tardio de PID do lease é ignorado

ID: `cap:prisma:concurrency-authority#RN-18`
Status no ensaio: **Candidate**

O registro do processo do agente só é gravado enquanto o lease que o pediu ainda é o vigente e a posse confere. Registro que chega depois da liberação ou de um takeover é ignorado.

source_refs: consulte o bloco deste RN em Referências.

Limite: sem origem no Roadmap.

### RN-19 — Escrita atômica resiste a crash do processo

ID: `cap:prisma:concurrency-authority#RN-19`
Status no ensaio: **Candidate**

A escrita do estado vai para um temporário no mesmo diretório, é sincronizada, conferida contra escritor externo e publicada por rename. Crash em qualquer passo deixa o estado anterior inteiro ou o novo inteiro, nunca um arquivo parcial. As premissas de ambiente e os limites ficam declarados.

source_refs: consulte o bloco deste RN em Referências.

Limite: não cobre queda de energia nem filesystem sem rename atômico.

### RN-20 — Temporário órfão é descartado, nunca aplicado

ID: `cap:prisma:concurrency-authority#RN-20`
Status no ensaio: **Candidate**

Na inicialização, temporários de escrita deixados por processo morto ou antigos são descartados e nunca aplicados como estado. Temporário de processo vivo com menos de 10 minutos é preservado.

source_refs: consulte o bloco deste RN em Referências.

Limite: pontos de entrada além do orquestrador não verificados.

### RN-21 — Auditoria de conflitos é append-only e sem conteúdo sensível

ID: `cap:prisma:concurrency-authority#RN-21`
Status no ensaio: **Candidate**

Cada conflito de versão, de sessão ou abandono de retry gera um evento só acrescentado. O evento usa lista fixa de campos, sem estado inteiro, ACs, entradas humanas, notas ou credenciais, e o hash da spec e a posse da execução aparecem só com 8 caracteres.

source_refs: consulte o bloco deste RN em Referências.

Limite: a auditoria não é fonte de estado; retenção não definida. O código grava a identidade da operação truncada a 64 caracteres e o id do run inteiro.

### RN-22 — Tela avisa antes do clique, mas quem decide é o CAS do servidor

ID: `cap:prisma:concurrency-authority#RN-22`
Status no ensaio: **Candidate**

A tela consulta uma versão mínima do run aberto e avisa, sem bloquear, quando o servidor está à frente do que foi carregado. Ação enviada com tela velha recebe conflito com a mesma mensagem. A comparação na tela é só dica: a decisão é sempre do CAS no servidor.

source_refs: consulte o bloco deste RN em Referências.

Limite: o endpoint do servidor não está entre as fontes fixadas.

## UNKNOWNs e precedência não resolvida

### RN-07 — Expurgo de processed_operations a cada ciclo

ID: `cap:prisma:concurrency-authority#RN-07`
Status no ensaio: **UNKNOWN — precedência não resolvida**

A documentação local e o prompt da task-76 zeram a lista de operações processadas no início de cada ciclo. O Roadmap exige que o desfecho de idempotência fique retido por um horizonte que cubra retry, replay, Recovery e tentativas tardias.

source_refs: consulte o bloco deste RN em Referências.

Limite: precedência não decidida; fora da extração contratual candidata.

- U-01: o mecanismo físico de serialização, fencing e fechamento da janela entre verificação e emissão é HD-009, DEFERRED. Nenhum RN escolhe lock, lease ou store.
- U-02: o CAS local reconhece repetição só por `operation_id`. Mesmo id com conteúdo diferente devolve `already_processed`, enquanto RN-03 exige conflito. O teste `scripts/state-concurrency.test.js:447` fixa esse comportamento (mesmo id, outra mutação, resposta `already_processed`), então não é evidência neutra para RN-02 nem RN-14. Divergência candidata, sem decisão de correção neste ensaio.
- U-03: o índice do Roadmap atribui a task-76 a DOM-02, com subjects de DOM-01, DOM-03, DOM-04 e DOM-05. Um único `state.json` por run guarda subjects de vários owners; a relação entre esse arquivo e o S2 por subject de um owner não está decidida.
- U-04: o despacho local é reservado por ticket entre processos (PRI-218). O Roadmap trata o disparo como pedido de admissão idempotente no owner (RRC-ST-002, RRC-DP-001) e diz que checar existência ou 409 na interface não garante single-winner (revisão semântica da task-55, citada só como contexto: a linha de índice da task-55 não está entre os localizadores fixados). A reserva por ticket não é tratada como admissão idempotente.
- U-05: o contexto histórico da task-76 afirma que CAS, escrita atômica e execution_id bastam no modelo local; a revisão semântica qualifica isso (RN-05). A afirmação não entra como RN.
- U-06: HD-AF-011 aparece na v80 só como resíduo preservado do RRC-ST-002. Não sustenta RN próprio.
- U-07: HD-AF-018 (modelo de Gate, DOM-03 único writer) é citado na linha da task-76. O conteúdo relevante chega pelo RRC-F20A-002 no próprio card (RN-05); HD-AF-018 não é source_ref direta.
- U-08: o bloco RRC-SDD do card da task-76 trata do registro por capability (`log.json`), não do `state.json`. Não é extraído como RN; orienta o exemplo de log do ensaio.
- U-09: AC-09 (os dez testes de concorrência passam) e AC-10 (mapa de concorrência entregue) são critérios de entrega da task-76, não RN. Nenhum teste foi executado neste ensaio; a presença dos testes não é PASS.
- U-10: RN-17 e RN-18 (PRI-218, PRI-229) e RN-11, RN-15 têm origem só na documentação local versionada; não há card do Roadmap que os sustente.
- U-11: a documentação local gira a posse da execução em takeover (retomada, novo QA, replay). O prompt do card diz que ela "persiste até commit ou falha definitiva". A rotação tem origem só local; RN-13 a registra sem resolver a divergência.
- U-12: o protocolo de reserva, efeito e desfecho com conferência no destino está documentado só para o comentário de aprovação no Redmine (RN-16). Outros efeitos externos ficam com RN-06 e OUTCOME_UNKNOWN, sem protocolo extraído.

## Fluxos e critérios do ensaio

1. RN de fonte existente possui doc+seção+commit ou card+versão+hash; precedência não decidida fica UNKNOWN, fora das regras candidatas.
2. Onde o documento local e o Roadmap divergem, o RN segue a qualificação do Roadmap ou fica UNKNOWN; o mecanismo local não é promovido a garantia arquitetural.
3. Matriz externa cobre todos os IDs, inclusive UNKNOWN, com limites de cobertura; toda conformidade permanece UNVERIFIED.
4. Exemplos externos de registros de operação percorrem, no papel, concorrência, crash e replay.
5. Revisão independente e handoff validado antecedem a conclusão do ensaio.

## Referências e limites

- Matriz, log-exemplo, lições e recibos: pacote `prisma-evidence/sdd-2026-10-22/p1b/`, fora da fonte normativa e do runtime.
- `docs/concurrency-map.md` e os arquivos de código citados: consultar na revisão fixada de cada source_ref.
- Modelo do ensaio: Candidate P1 (`06e0fe2`), `pilots.md` §P1, `proposal-sdd-capability.md` e a decisão RRC-SDD de 27/10/2026.

## Referências — source_refs versionadas por RN

Metadados de origem fora das seções contratuais do HASH_SCOPE. A localização não lhes confere autoridade de writer.

### cap:prisma:concurrency-authority#RN-01

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-001 (S1, HD-AF-008)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-ST-002 (resíduo: S1=run não significa uma única run por contrato); RRC-ST-005"
  }
]
```

### cap:prisma:concurrency-authority#RN-02

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-001 (S2, HD-AF-013); RRC-ST-005"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-DP-004, ordenação (4)"
  },
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Idempotência"
  }
]
```

### cap:prisma:concurrency-authority#RN-03

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-001 (S3, HD-AF-014)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-003; RRC-DP-006"
  }
]
```

### cap:prisma:concurrency-authority#RN-04

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-DP-005"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-001 (sem atomicidade entre owners/subjects independentes)"
  }
]
```

### cap:prisma:concurrency-authority#RN-05

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Índice de tasks, linha 76 — Revisão semântica (B)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-TA-004"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação aprovada F29 — RRC-F20A-002"
  }
]
```

### cap:prisma:concurrency-authority#RN-06

```yaml
source_refs: [
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-RCV-002"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-DP-004 (emissão externa fora do commit; OUTCOME_UNKNOWN)"
  }
]
```

### cap:prisma:concurrency-authority#RN-07

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "execution_id"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Prompt para o ciclo /plan — IDEMPOTÊNCIA EM OPERAÇÕES HUMANAS"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-DP-006"
  }
]
```

### cap:prisma:concurrency-authority#RN-08

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Mapa de concorrência do state.json — tabela de peças (Writer)"
  },
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Garantias verificadas por teste"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-03; Prompt para o ciclo /plan — ATOMIC WRITE (única função autorizada)"
  }
]
```

### cap:prisma:concurrency-authority#RN-09

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Operações críticas e como cada uma está protegida (cas.REQUIRED)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-02; Prompt para o ciclo /plan — COMPARE-AND-SET"
  }
]
```

### cap:prisma:concurrency-authority#RN-10

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Campos críticos (incrementam `state_version`)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-01; Prompt para o ciclo /plan — STATE_VERSION MONOTÔNICO"
  }
]
```

### cap:prisma:concurrency-authority#RN-11

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Campos críticos (incrementam `state_version`) — Edição fora do writer"
  }
]
```

### cap:prisma:concurrency-authority#RN-12

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Política de retry por tipo de operação"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Prompt para o ciclo /plan — COMPARE-AND-SET (Política de retry no caller); AC-07"
  }
]
```

### cap:prisma:concurrency-authority#RN-13

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "execution_id"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-06; Prompt para o ciclo /plan — EXECUTION_ID E SESSÃO CONCORRENTE"
  }
]
```

### cap:prisma:concurrency-authority#RN-14

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Idempotência"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-05; Prompt para o ciclo /plan — IDEMPOTÊNCIA EM OPERAÇÕES HUMANAS"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-CT-003; RRC-DP-006"
  }
]
```

### cap:prisma:concurrency-authority#RN-15

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Run arquivado ou movido"
  }
]
```

### cap:prisma:concurrency-authority#RN-16

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Aprovação pelo dashboard (efeito externo: comentário no Redmine)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Reconciliação F29 — RRC-DP-004 (emissão externa fora do commit; OUTCOME_UNKNOWN)"
  }
]
```

### cap:prisma:concurrency-authority#RN-17

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Despacho por ticket (PRI-218)"
  },
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Operações críticas e como cada uma está protegida (Despacho de um ticket)"
  }
]
```

### cap:prisma:concurrency-authority#RN-18

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Operações críticas e como cada uma está protegida (Carimbo de PID do lease)"
  }
]
```

### cap:prisma:concurrency-authority#RN-19

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Fluxo de escrita atômica (e o que acontece em cada crash)"
  },
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Ambiente (base das garantias)"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-04; Prompt para o ciclo /plan — ATOMIC WRITE"
  }
]
```

### cap:prisma:concurrency-authority#RN-20

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Fluxo de escrita atômica (e o que acontece em cada crash) — Startup do orquestrador"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "Prompt para o ciclo /plan — ATOMIC WRITE (inicialização do orquestrador)"
  }
]
```

### cap:prisma:concurrency-authority#RN-21

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Auditoria"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-08; Prompt para o ciclo /plan — AUDITORIA DE CONFLITOS"
  }
]
```

### cap:prisma:concurrency-authority#RN-22

```yaml
source_refs: [
  {
    "kind": "doc_section",
    "id": "docs/concurrency-map.md",
    "project": "prisma",
    "commit": "d1dfd2bae499911994decf8b340e0aefe18f886e",
    "locator": "Dashboard"
  },
  {
    "kind": "roadmap_card",
    "id": "task-76",
    "project": "prisma",
    "version": "1793717367-596d",
    "hash": "4ab82b702363b746c777cedafb3fc8a56296e367bf118b14be15370f52fad560",
    "locator": "AC-07; Prompt para o ciclo /plan — DASHBOARD"
  }
]
```
