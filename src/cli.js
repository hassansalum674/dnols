#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadManifests,
  readJsonFile,
  scoreManifest,
  searchManifests,
  validateManifest
} from "./lib/acm.js";

const [, , command, ...args] = process.argv;

async function main() {
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "validate") {
    await validateCommand(args);
    return;
  }

  if (command === "score") {
    await scoreCommand(args);
    return;
  }

  if (command === "search") {
    await searchCommand(args);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function validateCommand(args) {
  const target = resolve(args[0] ?? "data/manifests");
  const records = await loadTarget(target);
  let failures = 0;

  for (const record of records) {
    const label = record.manifest.namespace ?? record.filePath;
    if (record.validation.valid) {
      console.log(`ok ${label}`);
    } else {
      failures += 1;
      console.log(`fail ${label}`);
      for (const error of record.validation.errors) {
        console.log(`  - ${error}`);
      }
    }

    for (const warning of record.validation.warnings) {
      console.log(`  warning: ${warning}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

async function scoreCommand(args) {
  const target = resolve(args[0] ?? "data/manifests");
  const records = await loadTarget(target);

  for (const record of records) {
    const score = scoreManifest(record.manifest);
    console.log(`${record.manifest.namespace}: ${score.score}/100 (${score.grade})`);
    for (const reason of score.reasons) {
      console.log(`  - ${reason}`);
    }
  }
}

async function searchCommand(args) {
  const query = args.join(" ");
  const records = await loadManifests(resolve("data/manifests"));
  const results = searchManifests(records, query);

  for (const result of results) {
    console.log(`${result.namespace} (${result.registryScore}/100): ${result.name}`);
    console.log(`  ${result.summary}`);
    console.log(`  tags: ${result.tags.join(", ")}`);
  }
}

async function loadTarget(target) {
  const info = await stat(target);
  if (info.isDirectory()) {
    return loadManifests(target);
  }

  const manifest = await readJsonFile(target);
  return [
    {
      filePath: target,
      manifest,
      validation: validateManifest(manifest),
      score: scoreManifest(manifest)
    }
  ];
}

function printHelp() {
  console.log(`Agent-Capability Manifest MVP

Usage:
  node src/cli.js validate [file-or-directory]
  node src/cli.js score [file-or-directory]
  node src/cli.js search <query>

Examples:
  node src/cli.js validate data/manifests
  node src/cli.js score data/manifests/com.najd.procurement.json
  node src/cli.js search procurement compliance
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
