# Prisma

Prisma é uma plataforma de engenharia de software com agentes. Este bootstrap
prepara o repositório próprio; a implementação existente será extraída e adaptada
na PRI-60, a partir da fonte e da fronteira aceitas na PRI-58.

## Estado desta entrega

O conteúdo inicial reúne documentação nova, referências de proveniência e
diretórios reservados. O destino confirmado na PRI-59 é o repo privado
[RichardPFernandes/prisma](https://github.com/RichardPFernandes/prisma),
com branch inicial `main`. A implementação será incorporada pela PRI-60.

`app-back` será o primeiro projeto consumidor. Sua configuração, dados e estado
continuam no projeto consumidor, conforme os contratos e condições aplicáveis.

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
