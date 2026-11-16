---
id: sdd-writer
tipo: capacidade
resumo: Writer de SDD por projeto, que executa a consequência de uma Decision; congelado e sem chamador.
situacao: sem-chamador
spec: sem-spec
flags: []
modulos:
  - scripts/lib/sdd-writer*
---

# Writer de SDD

O writer de SDD (PRI-266) controla a versão e a ativação de uma SDD por projeto. A autoridade é a
Decision; o writer só executa a consequência. Ele lê o Git por objeto, nunca o working tree, guarda
um `log.json` canônico (JCS, RFC 8785) e deriva dele o `catalog.yaml`. A checagem de
integração (`sdd-writer-check.js`) é o único ponto de commit, e a auditoria roda depois. Ele não controla conteúdo nem navegação.

Está congelado pela D5 e nenhum código de produção o importa; só os testes e os utilitários de
teste (`sdd-writer-hostsim.js`, `sdd-writer-testkit.js`) o usam. Isso não é o `memory/spec/` do
consumidor nem a spec viva deste mapa.

## Por onde começar

1. [`scripts/lib/sdd-writer.js`](../../scripts/lib/sdd-writer.js): a entrada do writer.
2. [`scripts/lib/sdd-writer-check.js`](../../scripts/lib/sdd-writer-check.js): a checagem de integração e o commit.
3. [`scripts/lib/sdd-writer-log.js`](../../scripts/lib/sdd-writer-log.js): o formato do log e o estado derivado.
4. [`scripts/lib/sdd-writer-catalog.js`](../../scripts/lib/sdd-writer-catalog.js): o catálogo como projeção do log.
5. [`scripts/lib/sdd-writer-git.js`](../../scripts/lib/sdd-writer-git.js): o acesso ao Git por objeto.
