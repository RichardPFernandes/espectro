# Bootstrap do repositório

> Captura histórica da entrega indicada neste documento. Para o consumo entregue
> na PRI-63 (a50ff9f), o entrypoint de 08/10 e o retorno, consulte
> [consumer-operations.md](consumer-operations.md) e
> [extraction-handoff.md](extraction-handoff.md). As provas abaixo permanecem
> atribuídas à sua revisão original; não são instruções atuais de troca.

## Conteúdo inicial proposto

README.md, AGENTS.md, .gitignore, os documentos deste diretório e
provenance/source-baseline.json são materiais novos de preparação. Os placeholders
vazios de scripts, dashboard, .graph e templates reservam os caminhos mínimos para
a entrega seguinte. Não há arquivo da implementação existente incorporado aqui.

## Destino e operações

Destino confirmado pelo usuário na PRI-59: GitHub, conta `RichardPFernandes`,
repo privado [prisma](https://github.com/RichardPFernandes/prisma), branch inicial
`main`, checkout `/Users/richardfernandes/Workspace/prisma`. A operação autorizada
é criar e publicar somente este bootstrap próprio revisado. O repo privado foi
criado pela sessão autenticada do usuário; a publicação usa sua autenticação
SSH existente, sem incorporar implementação ou estado do consumidor.

O primeiro commit de bootstrap deve conter somente os arquivos iniciais
aceitos. Registrar URL/revisão, lista de arquivos, readback e estado limpo do novo
checkout. A configuração operacional de consumo será tratada na PRI-60; este
bootstrap não liga integração ou programa no consumidor.

## Requisitos de preparo e execução futura

Os materiais iniciais são texto UTF-8 e JSON, sem dependências executáveis.
Seu preparo/readback usa apenas Git e validação de arquivos; não exige Maven,
banco de negócio, credenciais de cliente ou um processo da plataforma.

O AS-IS tem dois pacotes Node separados: scripts (`graph-scripts`) e dashboard
(`graph-dashboard`), com manifests, locks e comandos próprios. Essa informação
orienta a organização mínima. A versão suportada de Node/npm, distribuição,
dependências, comandos finais e seus testes precisam ser atribuídos à revisão
extraída; a presença dos manifests não prova compatibilidade ou runtime.

Não há manifest/workspace/runner de raiz nesta entrega. A escolha da distribuição
futura deve respeitar os contratos aprovados e o delta real, sem duplicar o Core.

## Fonte e recuperação

O registro em provenance/source-baseline.json aponta à baseline aceita PRI-58:
identidade Git, digests e tratamento de tracked/untracked/ignored. A aceitação
documental da fonte não é backup nem prova de recuperação de seus bytes.

Antes de transportar código, demonstrar direitos/custódia, snapshot admissível
dos bytes selecionados e recuperação da mesma revisão. O HEAD isolado não
recupera arquivos locais ou alterações da árvore suja. Preservar a origem até
validação da candidata e prova de retorno; não operar writers antigos/novos
simultaneamente no mesmo subject fora da autoridade contratada.

O bootstrap Git materializado deve ter um commit inicial identificado para
permitir restaurar seu próprio ponto anterior. Isso não migra nem restaura o
estado autoritativo do consumidor. Reversão da extração tem entrega própria PRI-62.
