# Extração do Prisma — handoff de permanência

PRI-64 adapta a documentação ao destino privado
[RichardPFernandes/prisma](https://github.com/RichardPFernandes/prisma).
O app-back é consumidor/dogfood. A extração cobre código/assets selecionados,
integração e consumo local delimitados; não certifica toda a plataforma ou MP-00.

## Identidades e fontes

| Objeto | Referência e limite |
| --- | --- |
| Arquitetura | Freeze D-F30-01; Roadmap 1791252575-7603, SHA-256 2ce470da46d050e61a5042d5996d8e9698fb2e817765101c257347c1af61aa96 |
| Planejamento | D-F31-DIR-01/D-F31-01…09; [Approved FINAL F31](https://linear.app/prisma-app/document/f31-approved-document-final-planning-development-handoff-9d557a552a9a), Handoff c741587f-f777-4357-88a4-0ab244a7a697 na [PRI-53](https://linear.app/prisma-app/issue/PRI-53) |
| Plano de entregas | [Inventário E0–E6](https://linear.app/prisma-app/document/f31-inventario-as-is-e-plano-de-extracao-gradual-approved-d3e9d459ab50), derivado de F14/F23; T1–T9, F24 A1–A7, F25 O1–O21/P1–P7 por atividade |
| Bootstrap | 4e413c43d23040739701d8ca778290df93b135ca |
| Extração original | 04c130b00b7cce38ee17b1edc1d26ba67cd8c59a, 248 arquivos; fonte selecionada de 230 arquivos |
| Consumidor entregue | a50ff9fec1b44382eb6c97940b31a5bb42632a40, tree 97fe983cdbb51c91e639c8266819398800d67a64, 345 arquivos conferidos na PRI-63 |
| Fonte de retorno | HEAD app-back a1ac43307cc5f275caf5a70ad3068c9af099b127 + snapshot selecionado de 236 arquivos, hash 1191361d93f1a3dbe609a45bd881c0c8633bf8e491b99b5036b7d251aeda5731 |
| Base documental PRI-64 | main 38e9e92, posterior ao consumidor; não ativada por esta documentação |

Não atualizar metadata histórica de provenance/source-baseline.json ou
pri-62-rollback.json para simular que suas provas já cobriam revisões futuras.
[provenance/pri-64-documentation.json](../provenance/pri-64-documentation.json)
identifica os cinco drafts de origem e seus destinos.

## Sete entregas e evidências

| Entrega | Resultado delimitado | Prova / referência |
| --- | --- | --- |
| E0/E1 — [PRI-58](https://linear.app/prisma-app/issue/PRI-58) | Fonte/lista/fronteira aceitas; inventário inicial 297 e lista selecionada 230, sem direito inferido por pasta | [Fonte/lista APPROVED](https://linear.app/prisma-app/document/pri-58-fonte-fronteira-e-lista-por-arquivo-approved-7d18b9730d11), extraction-manifest.json |
| E2 — [PRI-59](https://linear.app/prisma-app/issue/PRI-59) | Repo privado e bootstrap publicados; readback remoto dos dez arquivos | [Evidence FINAL](https://linear.app/prisma-app/document/pri-59-evidence-final-bootstrap-github-verificado-b60fe4f83005), commit 4e413c4 |
| E3 — [PRI-60](https://linear.app/prisma-app/issue/PRI-60) | 230 escolhidos, direitos e recuperação apenas desse recorte; candidata 248 publicada | [Evidence FINAL](https://linear.app/prisma-app/document/pri-60-evidence-final-extracao-e3-verificada-dd774537d28e), extraction-manifest.json, pri-60-candidate.json |
| E4 — [PRI-61](https://linear.app/prisma-app/issue/PRI-61) | Integração e comparador no escopo observado; AC2 PARTIAL_UNKNOWN, sem prova DOM06 na revisão consumida | Evidências e waivers na issue; revalidação I01–I12 da PRI-63 |
| Retorno — [PRI-62](https://linear.app/prisma-app/issue/PRI-62) | C0–C5 6/6 e código/refs 7/7 em ensaios isolados; snapshot atualizado | pri-62-rollback.json, docs/rollback.md; revalidação C0–C5 da PRI-63 na revisão a50ff9f |
| E5 — [PRI-63](https://linear.app/prisma-app/issue/PRI-63) | APPLIED_BOUNDED local, depois APPLIED_PERSISTENT_ENTRYPOINT; consumo pinado, fonte preservada, loop global restaurado em 08/10 | Run arquivado pri-63-controlled-cutover no app-back: delivery.md, live-cutover-result.json, startup-followup-result.json, revisões e TAPs |
| E6 — [PRI-64](https://linear.app/prisma-app/issue/PRI-64) | Cinco drafts adaptados, runbook e índice de evidência; promoção por commit/PR com readback | Manifesto documental e revisão/teste/Verify associados à issue; encerramento depende da promoção e consistency final |

Os seis predecessores estão Done na consulta de 08/10/2026; seus status não
substituem provas. A revalidação PRI-63 tem **75 PASS / 0 FAIL / 0 SKIPPED**:
I01–I12 12, C0–C5 6 e correções dry-run/filtro/trava/identidade/lease/PR/manager 57.
Fixtures, providers falsos e HTTP locais delimitam esses ensaios. O pacote local
arquivado permanece no consumidor; não transportar seus states/logs de negócio
para a plataforma. Seus arquivos têm SHA-256 no manifesto documental quando usados.

## Consumo observado e deltas

Em 07/10, dashboard/API e dois ticks filtrados terminais foram observados sem
novo sujeito; somente metadata de polling/cleanup do terminal observado mudou
entre 835 states. Em 08/10, npm start do consumidor passou a selecionar o launcher,
com start:source para retorno; dependências não mudaram. A fonte atual tem esse
delta deliberado sobre o snapshot de retorno. O loop global foi restaurado e o
primeiro tick observado terminou idle sem erro. Não há claim de nova Task,
produção TMS, exclusividade entre hosts ou validação universal por esses fatos.

As correções posteriores de DOM06/Attempt em main (PR #14) não fazem parte do pin
a50ff9f nem encerram o UNKNOWN do cutover por herança. Revalidar delta e admissão
antes de trocar o consumidor. [Operação e retorno](consumer-operations.md).

## Carry-forward e continuidade

- RRC-F31-001/002 continuam NOT APPLIED; F30-F-005 e UNKNOWNs canônicos conservam
  seus gates. A extração física não redefine owners, authority ou contratos.
- [PRI-83](https://linear.app/prisma-app/issue/PRI-83) governa a auditoria transversal;
  [PRI-84](https://linear.app/prisma-app/issue/PRI-84) revalida CURRENT/MP-00 e
  [PRI-85](https://linear.app/prisma-app/issue/PRI-85) trata deltas SDD V2. São
  trabalhos posteriores, sem promoção automática de READY ou criação B01–B45.
- QA/merge dos PRs dos tickets drenados e DDL de cliente mantêm gates próprios;
  não usar a conclusão de extração para declarar essas mudanças implantadas.
- retry/throttle de REST do watcher não cobre chamadas MCP dos agentes. UNKNOWN
  ou resultado externo incerto não é PASS, zero, autorização ou licença de retry.
- Linear conserva planejamento/status/decisões; Roadmap governa arquitetura; Git
  conserva implementação/documentação; runtime/CI sustenta claims executados.

O Project original de sete entregas só pode ser encerrado após promoção E6,
handoff e consistency; PRI-84 foi acrescentada posteriormente e está Backlog.
A consistency final deve explicitar seu tratamento, sem concluir ou remover essa
issue por inferência. Nenhuma F32, limpeza do legado, migração de dados, início de
benchmark ou execução posterior ocorre automaticamente.
