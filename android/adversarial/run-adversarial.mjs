#!/usr/bin/env node
// Unified Adversarial Test Harness Runner for Milestone 1 Patch Engine
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const suites = [
  'axml-fuzz.test.mjs',
  'zip-slip.test.mjs',
  'zipalign-16kb.test.mjs',
  'apksig-tamper.test.mjs',
  'hermes-sha1.test.mjs',
  'empirical-challenger.test.mjs',
];

console.log('='.repeat(70));
console.log('   Milestone 1 Patch Engine: Adversarial Stress Test Harness');
console.log('='.repeat(70));

let totalPassed = 0;
let totalFailed = 0;

for (const suite of suites) {
  const suitePath = path.join(__dirname, suite);
  console.log(`\n▶ Running ${suite}...`);
  try {
    const out = execSync(`node --test "${suitePath}"`, { stdio: 'pipe' }).toString();
    console.log(out.trim());
    totalPassed++;
  } catch (err) {
    console.error(err.stdout ? err.stdout.toString() : err.message);
    totalFailed++;
  }
}

console.log('\n' + '='.repeat(70));
console.log(`Adversarial Suite Summary: ${totalPassed} suites passed, ${totalFailed} suites failed.`);
console.log('='.repeat(70));

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
