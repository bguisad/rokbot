#!/usr/bin/env node

import { MockHostServer } from './mock-host.mjs';
import { runTier1Tests } from './tier1-feature.test.mjs';
import { runTier2Tests } from './tier2-boundary.test.mjs';
import { runTier3Tests } from './tier3-combination.test.mjs';
import { runTier4Tests } from './tier4-application.test.mjs';

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

async function main() {
  console.log(`\n${BOLD}${CYAN}======================================================================${RESET}`);
  console.log(`${BOLD}${CYAN}   RokBot Native Android Client Patch — E2E Test Suite Runner        ${RESET}`);
  console.log(`${BOLD}${CYAN}======================================================================${RESET}\n`);

  const host = new MockHostServer({
    pairingKey: 'ABCDEF',
    adminPassword: 'AdminPass123!',
    maxDevices: 200,
    rateLimit: 50000
  });

  await host.start();
  console.log(`${DIM}Mock Host server initialized and listening at: ${BOLD}${host.origin}${RESET}\n`);

  const tiers = [
    { id: 'Tier 1', name: 'Feature Coverage (F1-F20)', runner: runTier1Tests, minRequired: 100 },
    { id: 'Tier 2', name: 'Boundary & Corner Cases (F1-F20)', runner: runTier2Tests, minRequired: 100 },
    { id: 'Tier 3', name: 'Cross-Feature Combinations', runner: runTier3Tests, minRequired: 20 },
    { id: 'Tier 4', name: 'Real-World Application Scenarios', runner: runTier4Tests, minRequired: 10 }
  ];

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const suiteResults = [];
  const globalStart = Date.now();

  for (const tier of tiers) {
    console.log(`${BOLD}${YELLOW}▶ Running ${tier.id}: ${tier.name}${RESET}`);
    const tierStart = Date.now();
    let passed = 0;
    let failed = 0;
    const failures = [];

    // Reset mock host state before each tier for pristine isolation
    host.reset();

    const tests = await tier.runner(host);
    for (const t of tests) {
      const tStart = Date.now();
      try {
        await t.fn();
        const duration = Date.now() - tStart;
        passed++;
        process.stdout.write(`  ${GREEN}✔${RESET} ${DIM}[${duration}ms]${RESET} ${t.name}\n`);
      } catch (err) {
        failed++;
        failures.push({ name: t.name, error: err });
        process.stdout.write(`  ${RED}✖ ${t.name}${RESET}\n`);
      }
    }

    const tierElapsed = Date.now() - tierStart;
    totalTests += tests.length;
    totalPassed += passed;
    totalFailed += failed;

    suiteResults.push({
      tier: tier.id,
      name: tier.name,
      count: tests.length,
      passed,
      failed,
      durationMs: tierElapsed
    });

    console.log(`  ${BOLD}${passed === tests.length ? GREEN : RED}Result: ${passed}/${tests.length} passed (${tierElapsed}ms)${RESET}\n`);

    if (failures.length > 0) {
      console.log(`  ${RED}${BOLD}Failures in ${tier.id}:${RESET}`);
      for (const f of failures) {
        console.log(`    ${RED}- ${f.name}:${RESET} ${f.error.message}`);
      }
      console.log();
    }
  }

  const globalElapsed = Date.now() - globalStart;

  // Print Summary Table
  console.log(`${BOLD}======================================================================${RESET}`);
  console.log(`${BOLD}                        TEST EXECUTION SUMMARY                        ${RESET}`);
  console.log(`${BOLD}======================================================================${RESET}`);
  console.log(`Tier    Name                                  Count   Pass   Fail   Time`);
  console.log(`----------------------------------------------------------------------`);
  for (const r of suiteResults) {
    const tierPad = r.tier.padEnd(7);
    const namePad = r.name.padEnd(37);
    const countPad = String(r.count).padStart(5);
    const passPad = String(r.passed).padStart(6);
    const failPad = String(r.failed).padStart(6);
    const timePad = `${r.durationMs}ms`.padStart(7);
    console.log(`${tierPad} ${namePad} ${countPad} ${passPad} ${failPad} ${timePad}`);
  }
  console.log(`----------------------------------------------------------------------`);
  const grandCount = String(totalTests).padStart(5);
  const grandPass = String(totalPassed).padStart(6);
  const grandFail = String(totalFailed).padStart(6);
  const grandTime = `${globalElapsed}ms`.padStart(7);
  console.log(`${BOLD}TOTAL                                         ${grandCount} ${grandPass} ${grandFail} ${grandTime}${RESET}`);
  console.log(`${BOLD}======================================================================${RESET}\n`);

  await host.stop();

  if (totalFailed > 0) {
    console.log(`${RED}${BOLD}✖ TEST SUITE FAILED (${totalFailed} failed out of ${totalTests})${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`${GREEN}${BOLD}✔ ALL ${totalTests} TESTS PASSED SUCCESSFULLY! (${globalElapsed}ms)${RESET}\n`);
    process.exit(0);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal runner error:${RESET}`, err);
  process.exit(1);
});
