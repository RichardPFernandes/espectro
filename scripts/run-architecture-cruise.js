#!/usr/bin/env node
"use strict";

/**
 * Roda dependency-cruiser com cwd = raiz do repo (paths ^scripts/ ^dashboard/).
 * Uso: node scripts/run-architecture-cruise.js [--baseline] [--check]
 * Default: --check (--ignore-known).
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, "..");
const depcruise = path.join(scriptsDir, "node_modules", ".bin", "depcruise");
const config = path.join(repoRoot, ".dependency-cruiser.cjs");
const baseline = path.join(repoRoot, ".dependency-cruiser-known-violations.json");

const mode = process.argv.includes("--baseline")
  ? "baseline"
  : process.argv.includes("--baseline-shrink")
    ? "baseline-shrink"
    : "check";

const args =
  mode === "baseline"
    ? [
        "-c",
        config,
        "--baseline",
        baseline,
        "--baseline-mode",
        "full",
        "--no-cache",
        "scripts",
        "dashboard",
      ]
    : mode === "baseline-shrink"
      ? [
          "-c",
          config,
          "--baseline",
          baseline,
          "--baseline-mode",
          "shrink-only",
          "--no-cache",
          "scripts",
          "dashboard",
        ]
      : [
          "-c",
          config,
          "--ignore-known",
          baseline,
          "--no-cache",
          "scripts",
          "dashboard",
        ];

const r = spawnSync(depcruise, args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
