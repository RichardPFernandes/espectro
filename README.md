# Prisma

Prisma é uma plataforma de engenharia de software com agentes. O bootstrap da
PRI-59 preparou este repositório. A PRI-60 traz a versão candidata da plataforma,
extraída da fronteira aceita na PRI-58, sem trocar a execução ativa do app-back.

## Estado desta entrega

A candidata está neste checkout, na branch de extração. O destino confirmado na
PRI-59 continua o repo privado
[RichardPFernandes/prisma](https://github.com/RichardPFernandes/prisma).
Consumo, retorno e o que ainda não foi trocado estão em
[docs/pri-60-candidate.md](docs/pri-60-candidate.md).

`app-back` segue o primeiro projeto consumidor e a origem em execução. A
configuração, os dados e o estado dele permanecem no projeto consumidor.

## Organização mínima proposta

- `scripts/`: pacote de ferramentas existente a extrair/adaptar na PRI-60.
- `dashboard/`: pacote de interface existente a extrair/adaptar na PRI-60.
- `.graph/`: definições e schemas selecionados, com configuração do consumidor
  delimitada antes do transporte.
- `templates/`: templates neutros selecionados e versionados.
- `docs/`: documentação técnica do bootstrap e da entrada de extração.
- `provenance/`: referência da baseline aceita e seus limites.

Os diretórios reservados não contêm implementação nesta entrega. A organização
preserva os caminhos dos pacotes AS-IS e não escolhe distribuição, engine ou
modelo de persistência novo.

## Entrada de desenvolvimento

Leia [o bootstrap](docs/bootstrap.md), [a entrada de extração](docs/extraction-entry.md)
e [a referência da fonte](provenance/source-baseline.json). Planejamento e decisões
operacionais permanecem no Linear; a arquitetura segue suas baselines congeladas.
Código e documentação técnica serão versionados no destino efetivamente autorizado.

O bootstrap não oferece comandos de execução da plataforma: a extração, a
compatibilidade dos pacotes, a integração e suas provas pertencem às entregas
seguintes do Project Repository Extraction & Bootstrap.
