# Entrada da PRI-60

> Captura histórica da entrega indicada neste documento. Para o consumo entregue
> na PRI-63 (a50ff9f), o entrypoint de 08/10 e o retorno, consulte
> [consumer-operations.md](consumer-operations.md) e
> [extraction-handoff.md](extraction-handoff.md). As provas abaixo permanecem
> atribuídas à sua revisão original; não são instruções atuais de troca.

## Entrada necessária

1. Destino Git confirmado, checkout delimitado, commit inicial e readback da PRI-59.
2. Fonte e lista aceitas da PRI-58, com hashes atuais conferidos antes da operação.
3. Direitos de origem/destino e escopo de escrita demonstrados para a cópia/reuso
   dependentes; custódia e recuperação da fonte quando necessárias à operação.
4. Delimitação das partes e do delta de cada arquivo classificado adaptar, antes
   de selecionar bytes para transporte.

## Fronteira a preservar

O código da plataforma e seus assets versionados são separados das referências
de configuração do projeto consumidor e de seus registros autoritativos. Usar
seams existentes de root, templates/config, workspace e adapters com mudanças
mínimas. `app-back` permanece consumidor e conserva conteúdo de negócio, dados,
segredos, instruções/configuração locais e histórico no escopo aplicável.

O mapa de dependências estático não cobre todos os paths de IO, shell/Python,
integrações e referências de configuração. Testar roots distintos de plataforma
e consumidor e compatibilidade dos contratos efetivamente modificados.

## Gates e resíduos

CURRENT/BND001/F23-001/HD009 e demais resíduos continuam por operação/faceta.
Snapshot, Context Record e bindings históricos não ganham semântica nova pelo
checkout do repo. Owners, S1/S2/S3, Gate/Policy, trust/classificação/lifecycle e
obrigações T1–T9/A1–A7/O1–O21/P1–P7 seguem as baselines pertinentes.

RRC-F31-001/002 não foram aplicados. F30-F-005 continua OPEN: PROMOTABLE não prova
as relações/gates de promoção. UNKNOWN necessário impede só a operação dependente,
sem tornar migração um bloqueio global para trabalho independente.

## Critério de prova

Referenciar a mesma versão candidata na extração, integração e retorno. A PRI-61
verifica consumo/comportamento/contratos no recorte executado; a PRI-62 demonstra
retorno na candidata efetiva. Cutover PRI-63 exige ambas e autoridade por operação.
Documentação/commits de permanência seguem PRI-64. Um repo novo ou build verde
isolado não substitui essas provas.
