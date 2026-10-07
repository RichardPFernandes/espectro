# Mapa antes/depois — PRI-60

| Seam | Origem | Candidata |
| --- | --- | --- |
| Código watcher/helpers | app-back/scripts | Prisma/scripts fixado (__dirname) |
| Dashboard/public assets | app-back/dashboard | Prisma/dashboard fixado (__dirname) |
| Consumer root/cwd | frequentemente derivado de __dirname | REPO_PATH/options/cwd do consumidor |
| .env | pasta do executável/projeto misturadas | referência ao consumidor; nenhuma cópia |
| Runs/spec/archives/knowledge | memória app-back | mesmo consumidor e owners, nenhum transporte |
| Prefs/pid/history/local-checkout marker | dashboard junto código | dashboard path no consumidor |
| Templates de nó | slash command do checkout | asset candidato fixado; contexto/execução no consumidor |
| Scripts nos templates | scripts relativo ao projeto | PRISMA_ROOT/scripts explícito |
| Schema/graph distribuído | bytes locais aceitos (inclusive dirty tracked) | mesmos contratos; não substitui bindings antigos |
| HASH_SCOPE/config-contract do subject | .claude do app-back | consumidor; IDs/snapshot não reinterpretados |
| Siblings | app-front/app-core/mo-entity implícitos | WATCHER_SIBLING_REPOS explícito |
| Build/test | Maven implícito | comando de toolchain do consumidor |
| Preview | Quarkus/Grunt/profiles de cliente implícitos | adapter existente explicitamente configurado |
| Taxonomia e ResponseFactory | TMS no código | JSON/refs específicos no consumidor |

Detalhes por arquivo: provenance/extraction-manifest.json. Adaptar significa
revisar a fronteira, não editar todos219arquivos: bytes sem delta necessário
continuam atribuídos como preservados. Os11extrair têm integridade byte-a-byte.
Configurações de integração são referências de adapters existentes, sem novo
modelo de authority/owner/writer. Fonte/runs/env/config históricos preservados.
