/**
 * PRI-104 / F02B — fronteiras de camadas (proposta TS §3.2, D1).
 * Escaneia JS legado e TS novo. Violações legadas ficam em
 * .dependency-cruiser-known-violations.json (ratchet: só diminui).
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Sem ciclos entre módulos.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-lib-upward",
      severity: "error",
      comment:
        "scripts/lib/* não sobe para scripts/ (G2). Baseline = subidas atuais; F07A remove as de writers.",
      from: { path: "^scripts/lib/" },
      to: {
        path: "^scripts/",
        pathNot: "^scripts/lib/",
      },
    },
    {
      name: "no-dashboard-scripts-internals",
      severity: "error",
      comment:
        "dashboard não importa scripts/lib nem writers concretos (G3). Público = application/composition (após F12).",
      from: { path: "^dashboard/" },
      to: {
        path: "^scripts/(lib/|state-writer|cas|invalidate|notify|readmine-watcher)",
      },
    },
    {
      name: "domain-no-outer",
      severity: "error",
      comment: "domain só importa domain (e tipos gerados).",
      from: { path: "^scripts/src/domain/" },
      to: {
        path: "^scripts/src/(ports|application|adapters|config|composition|interface)/",
      },
    },
    {
      name: "domain-no-node-io",
      severity: "error",
      comment: "domain sem node:fs/child_process/http/net.",
      from: { path: "^scripts/src/domain/" },
      to: {
        dependencyTypes: ["core"],
        path: "^(fs|fs/promises|child_process|http|https|net|node:fs|node:fs/promises|node:child_process|node:http|node:https|node:net)$",
      },
    },
    {
      name: "ports-no-adapters-or-app",
      severity: "error",
      from: { path: "^scripts/src/ports/" },
      to: {
        path: "^scripts/src/(adapters|application|composition|interface|config)/",
      },
    },
    {
      name: "application-no-adapters",
      severity: "error",
      from: { path: "^scripts/src/application/" },
      to: {
        path: "^scripts/src/(adapters|composition|interface)/",
      },
    },
    {
      name: "adapters-no-application",
      severity: "error",
      from: { path: "^scripts/src/adapters/" },
      to: {
        path: "^scripts/src/(application|interface|composition)/",
      },
    },
    {
      name: "config-no-application",
      severity: "error",
      from: { path: "^scripts/src/config/" },
      to: {
        path: "^scripts/src/(application|domain)/",
      },
    },
    {
      name: "no-import-composition",
      severity: "error",
      comment: "composition só é importada por interface/entrypoints.",
      from: {
        path: "^scripts/src/(domain|ports|application|adapters|config)/",
      },
      to: { path: "^scripts/src/composition/" },
    },
    {
      name: "interface-no-adapters-domain-writers",
      severity: "error",
      from: { path: "^scripts/src/interface/" },
      to: {
        path: "^scripts/src/(adapters|domain)/",
      },
    },
    {
      name: "dashboard-src-no-scripts-domain-adapters",
      severity: "error",
      from: { path: "^dashboard/src/" },
      to: {
        path: "^scripts/src/(domain|adapters)/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: [
        "node_modules",
        "dist",
        "coverage",
        "\\.dependency-cruiser",
        "scripts/lib/.*\\.test\\.js$",
        "dashboard/.*\\.test\\.js$",
        "scripts/.*\\.test\\.js$",
        "harness/",
      ],
    },
    extraExtensionsToScan: [".ts"],
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    moduleSystems: ["cjs", "es6", "tsd"],
  },
};
