---
id: config
tipo: base
resumo: Confere a configuração do fluxo contra o contrato; o registro de flags ainda não existe.
situacao: parcial
spec: sem-spec
flags: []
modulos:
  - scripts/validate-config.js
  - scripts/lib/config-validator.js
---

# Config

A configuração do fluxo (`.claude/`, `.graph/` e `.env.example`) é conferida contra o contrato
`.claude/config-contract.json`. O `validate-config.js` roda as regras do contrato: schema dos
arquivos, nó sem comando, ciclo no grafo, estado incompatível com o schema, variável lida no
código sem entrada no `.env.example`, worktree de ciclo encerrado e a política de roteamento.
Nenhuma regra escreve em disco; só `--fix` remove worktree. O painel do dashboard roda o mesmo
script e mostra o resultado.

Está `parcial` porque não há registro de flags: o `.env.example` documenta as variáveis, mas
nada diz o valor de cada flag no consumidor. Esse registro é a fatia F1.1 do roadmap. Cada
leitura de variável continua no módulo que a usa; cada capacidade lista as suas flags.

## Por onde começar

1. [`.claude/config-contract.json`](../../.claude/config-contract.json): as regras, a severidade e a versão do contrato.
2. [`scripts/lib/config-validator.js`](../../scripts/lib/config-validator.js): uma função por regra; o comentário do topo diz por que existem.
3. [`scripts/validate-config.js`](../../scripts/validate-config.js): a linha de comando, com `--format json` e `--fix`.
4. [`.env.example`](../../.env.example): as variáveis de ambiente conhecidas.
5. [`docs/consumption.md`](../consumption.md): o que é do Espectro e o que é configuração do consumidor.
