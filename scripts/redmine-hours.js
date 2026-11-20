'use strict';
// Superfície pública (G3 / PRI-104): o dashboard não importa scripts/lib/*.
// Reexporta só o necessário ao job de backfill de horas Redmine M&O.
// Internos continuam em scripts/lib/; F12 (application/composition) pode
// substituir este barrel sem mudar o contrato do dashboard.

const { createRedmineFetch } = require('./lib/redmine-fetch');
const {
  runBackfill,
  DEFAULT_ACTIVITY_ID,
} = require('./lib/redmine-hours-sync');

module.exports = {
  createRedmineFetch,
  runBackfill,
  DEFAULT_ACTIVITY_ID,
};
