#!/usr/bin/env node

/**
 * ghost-pilot CLI — Playwright orchestration × real OS-level mouse events
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runScenario } from '../src/orchestrator.mjs';

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
🛩️  ghost-pilot — Real mouse automation for screen recording

USAGE:
  ghost-pilot run <scenario.json> [options]

OPTIONS:
  --speed <n>     Playback speed multiplier (default: 1.0)
  --quiet         Suppress verbose output

EXAMPLES:
  ghost-pilot run scenarios/antdv-button.json
  ghost-pilot run scenarios/antdv-button.json --speed 0.8
`);
}

// Parse command
const command = args[0];

if (!command || command === 'help' || command === '--help') {
  printUsage();
  process.exit(0);
}

if (command === 'run') {
  const scenarioPath = args[1];
  if (!scenarioPath) {
    console.error('❌ Please specify a scenario file.\n');
    printUsage();
    process.exit(1);
  }

  // Parse flags
  let speed = 1.0;
  let verbose = true;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--speed' && args[i + 1]) {
      speed = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--quiet') {
      verbose = false;
    }
  }

  // Load scenario
  const fullPath = resolve(scenarioPath);
  let scenario;
  try {
    const raw = readFileSync(fullPath, 'utf-8');
    scenario = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Failed to load scenario: ${fullPath}`);
    console.error(`   ${err.message}`);
    process.exit(1);
  }

  // Run
  runScenario(scenario, { speed, verbose })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Scenario failed:', err.message);
      process.exit(1);
    });
} else {
  console.error(`❌ Unknown command: ${command}\n`);
  printUsage();
  process.exit(1);
}
