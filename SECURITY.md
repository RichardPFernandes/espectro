# Segurança

## Como relatar uma vulnerabilidade

Use o relato privado de vulnerabilidade do GitHub: na página do repositório, aba
**Security → Report a vulnerability**. Não abra issue pública nem PR com os detalhes.

Inclua, se puder: o que acontece, como reproduzir, a versão (commit) e o impacto que você vê.
Não inclua segredos, tokens ou dados de terceiros no relato.

## Escopo

Está em escopo o código deste repositório: `scripts/`, `dashboard/`, `harness/`, `tools/` e a
configuração em `.github/`.

Fora de escopo: os projetos consumidores que usam o Espectro, a configuração e os dados deles,
e serviços de terceiros (GitHub, provedores de modelo, trackers).

## Aviso sobre o dashboard

O dashboard é uma ferramenta local. Ele escuta em loopback (`127.0.0.1`) e não foi feito para
ser exposto em rede. Não publique a porta dele fora de loopback: nada de bind em `0.0.0.0`,
proxy reverso, túnel ou encaminhamento de porta. Quem alcança o dashboard pode ler runs e
acionar ações do agente na máquina.
