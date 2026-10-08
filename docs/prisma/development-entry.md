# Entrada para desenvolvimento — extração gradual

Prisma tem repo próprio e app-back consumidor/dogfood. A extração PRI-58–63 está documentada no [handoff](../extraction-handoff.md). Trabalho posterior parte do delta real na revisão selecionada; a extração entregue não certifica MP-00 ou SDD READY.

Instrução atual no Linear: https://linear.app/prisma-app/document/f31-instrucao-de-entrada-para-desenvolvimento-approved-802e843abece

Recuperar AGENTS/project/index/.graph do host; pacote F31 e Freeze; delimitar árvore e autoridade. Classificar plataforma Prisma, app-back e integração; mapear contratos e dependências; preservar ambiguidades e BND001/CURRENT/HD009/F23-001. Separar trabalho independente do que depende do cutover. Preparar plano incremental com provas, reversibilidade e preservação de proveniência.

A1–A7/F24, T1–T9/F23 e O1–O21/P1–P7/F25 governam entrada e validação. F30-F-005 permanece OPEN: PROMOTABLE não prova resolução de U/gates. Encontrados ACs/validator/scorer/registry em scripts/lib; selecionar próximo trabalho pelo delta real, sem duplicar paths do Roadmap ou tratar task61 como pendente automaticamente.

Não escrever/mover/copiar/criar repo/publicar/iniciar watcher pelo texto de diagnóstico. Execução precisa de escopo/autorização próprios e Review/Test/Verify/Commit; metadata não certifica conformidade/runtime.

Derivado do draft F31 de mesmo nome, adaptado na PRI-64 em 2026-10-08. Origem e hash estão em [provenance/pri-64-documentation.json](../../provenance/pri-64-documentation.json). Esta síntese preserva os contratos; decisões/status correntes ficam no Linear.
