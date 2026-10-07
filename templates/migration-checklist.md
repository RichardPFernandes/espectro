## ⚠️ Schema Migration Checklist

> Gerada automaticamente pelo watcher (`scripts/lib/schema-watcher.js`) porque o diff
> deste ticket altera schema (migration Flyway, mapeamento JPA ou `persistence.xml`).
> **Não bloqueia o ciclo** — é um alerta. Marque os itens conforme forem resolvidos e
> registre aqui o que foi decidido; o bloco só é regenerado se as mudanças detectadas
> mudarem.

**Nível de risco:** {{RISK_LEVEL}}
**Tabelas afetadas:** {{AFFECTED_TABLES}}

### Mudanças detectadas

{{CHANGES_LIST}}

### Rollback script

Sugestões por mudança (revise — são ponto de partida, não script pronto):

{{ROLLBACK_HINTS}}

- [ ] Script de rollback escrito e versionado (ou justificado por que não se aplica)
- [ ] Rollback testado em banco local/homologação após aplicar a migration
- [ ] Backup/dump das tabelas afetadas antes de qualquer `DROP`/`RENAME` em produção

### Validação em homologação

- [ ] Migration aplicada em homologação sem erro (`flyway info`/`validate` limpos, quando houver Flyway)
- [ ] Mapeamento JPA confere com o schema aplicado (sem erro de validação do Hibernate na subida)
- [ ] Versão anterior da aplicação continua funcionando com o schema novo (deploy sem downtime)
- [ ] Volume de dados / tempo de execução medido em base com tamanho próximo ao de produção

### Comunicação DBA

- [ ] DBA avisado das mudanças e do nível de risco acima
- [ ] Impacto em índices, locks e replicação revisado com o DBA
- [ ] Permissões/grants necessários confirmados

### Janela de manutenção

- [ ] Necessidade de janela avaliada (obrigatória para risco 🔴 high)
- [ ] Janela agendada e comunicada aos envolvidos (suporte, QA, clientes afetados)
- [ ] Responsável pelo rollback definido durante a janela
