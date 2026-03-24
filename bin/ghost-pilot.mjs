#!/usr/bin/env node

/**
 * ghost-pilot CLI — Playwright orchestration × real OS-level mouse events
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runScenario } from '../src/orchestrator.mjs';
import { startRecording } from '../src/recorder.mjs';

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
🛩️  ghost-pilot — Real mouse automation for screen recording

USAGE:
  ghost-pilot run <scenario.json> [options]
  ghost-pilot record --url <URL> [-o output.json]

COMMANDS:
  run       Run a recorded/written scenario with real mouse events
  record    Open a browser and record your interactions as scenario JSON

RUN OPTIONS:
  --speed <n>     Playback speed multiplier (default: 1.0)
  --quiet         Suppress verbose output

RECORD OPTIONS:
  --url <URL>     Page to open for recording (required)
  -o <file>       Output scenario file (default: scenario.json)
  --width <n>     Viewport width (default: 1440)
  --height <n>    Viewport height (default: 900)

EXAMPLES:
  ghost-pilot record --url https://antdv.com/components/button -o scenarios/antdv.json
  ghost-pilot run scenarios/antdv.json
  ghost-pilot run scenarios/antdv.json --speed 0.8
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

} else if (command === 'record') {
  // Parse record flags
  let url = null;
  let output = 'scenario.json';
  let width = 1440;
  let height = 900;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) { url = args[i + 1]; i++; }
    else if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) { output = args[i + 1]; i++; }
    else if (args[i] === '--width' && args[i + 1]) { width = parseInt(args[i + 1]); i++; }
    else if (args[i] === '--height' && args[i + 1]) { height = parseInt(args[i + 1]); i++; }
  }

  if (!url) {
    console.error('❌ Please specify --url for recording.\n');
    printUsage();
    process.exit(1);
  }

  startRecording({
    url,
    output: resolve(output),
    viewport: { width, height },
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Recording failed:', err.message);
      process.exit(1);
    });

} else {
  console.error(`❌ Unknown command: ${command}\n`);
  printUsage();
  process.exit(1);
}
