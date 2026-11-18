/**
 * PRI-406 / F0.7 — ESLint só de erros sobre o JavaScript de produção de
 * scripts/ e dashboard/. Regras: eslint:recommended (todas em "error", sem
 * estilo). As violações que já existem ficam em scripts/lint-baseline.json e
 * só podem diminuir (scripts/run-eslint-prod.js). O TypeScript de src/ segue
 * no eslint.config.mjs (npm --prefix scripts run lint:src).
 * Dependências vivem em scripts/node_modules (sem runner de raiz).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromScripts = createRequire(
  path.join(__dirname, "scripts", "package.json")
);
const js = requireFromScripts("@eslint/js");
const globals = requireFromScripts("globals");

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // testes e fixtures não são código de produção
      "**/*.test.js",
      "scripts/fixtures/**",
      "scripts/harness/**",
    ],
  },
  {
    files: ["scripts/**/*.{js,cjs}", "dashboard/**/*.{js,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: { ...globals.node },
    },
  },
  {
    // JavaScript do navegador: scripts clássicos carregados pelo index.html.
    // Eles usam globais (esc, $, api, runs...) definidos no script inline do
    // index.html, que o ESLint não lê; por isso no-undef fica fora aqui.
    files: ["dashboard/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: "latest",
      globals: { ...globals.browser },
    },
    rules: { "no-undef": "off" },
  },
];
