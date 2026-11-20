#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const repoRoot = path.resolve(__dirname, "..");
const eslint = path.join(__dirname, "node_modules", ".bin", "eslint");
const r = spawnSync(
  eslint,
  ["-c", path.join(repoRoot, "eslint.config.mjs"), "scripts/src", "dashboard/src"],
  { cwd: repoRoot, stdio: "inherit", env: process.env }
);
process.exit(r.status === null ? 1 : r.status);
