# Prisma

Plataforma de engenharia de software com agentes, extraída para o repositório
privado [RichardPFernandes/prisma](https://github.com/RichardPFernandes/prisma).
O app-back é o primeiro consumidor/dogfood; configuração, credenciais, dados,
worktrees e estado autoritativo permanecem no consumidor.

## Entrada

- [Baseline e contratos](docs/prisma/README.md): cinco documentos F31 adaptados.
- [Consumo, diagnóstico, cutover e retorno](docs/consumer-operations.md).
- [Handoff da extração](docs/extraction-handoff.md): sete entregas, provas e limites.
- [Paths extraídos](docs/extraction-paths.md) e [manifesto](provenance/extraction-manifest.json).
- [Workflow e troubleshooting](docs/runbook.md), [specs](docs/spec-guide.md).

## Revisões

O consumidor entregue na PRI-63 está fixado em `a50ff9f`; a main posterior contém
mudanças que ainda não foram admitidas nele. Não usar latest para reatar uma Run
nem atualizar o pin pela publicação de documentação. `npm start` do dashboard do
app-back chama seu launcher; `npm run start:source` é o retorno explícito após
parada, conferência de writers e saneamento do ambiente.

Dois pacotes Node separados, scripts/ e dashboard/, com manifests/locks próprios;
a extração foi verificada com Node 20.20.2/npm 10.8.2. Não há runner de raiz.
Preparação isolada e comandos operacionais estão no runbook de consumo; este
README não inicia watcher, agente ou preview.

## Governança

Roadmap/Freeze governam arquitetura, Linear conserva planejamento e decisões,
Git conserva implementação/documentação e runtime/CI comprova o que foi executado.
Plan → Implement → Review independente → Test → Verify → Commit. A extração local
não certifica MP-00, SDD READY, produção TMS ou DOM06 na revisão consumida.
RRC-F31-001/002 continuam NOT APPLIED; nenhum dado/estado do app-back acompanha
esta promoção documental. Proveniência em
[pri-64-documentation.json](provenance/pri-64-documentation.json).

## Histórico atribuído

[Bootstrap PRI-59](docs/bootstrap.md), [entrada PRI-60](docs/extraction-entry.md),
[candidata PRI-60](docs/pri-60-candidate.md), [consumo original](docs/consumption.md)
e [retorno PRI-62](docs/rollback.md) conservam capturas das respectivas revisões.
O estado entregue e as instruções de operação atuais estão no handoff e no
runbook de consumo acima, sem retrocertificar essas capturas.
