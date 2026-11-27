#!/usr/bin/env node
// Entry point: `rokbot` (npm i -g rokbot), `npx rokbot`, or `node bin/rokbot.mjs` in a checkout.
import { main } from '../scripts/cli/main.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(`错误：rokbot 需要 Node.js 20 或更新版本，当前为 ${process.versions.node}\n`);
  process.exit(1);
}
process.exitCode = await main(process.argv.slice(2));
