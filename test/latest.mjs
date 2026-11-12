// Whether the README still pins each tool at the release npm calls latest,
// for the scheduled run: a README whose examples name an older release sends
// its readers to it. A failure here is not a broken action: it says the
// README's pins are due a bump.
//
//   node test/latest.mjs
//
// It reads README.md and the npm registry, and nothing else.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

// Each `version:` a step gives, with the `tool:` of the same step. A step
// opens with `- `, and a fence closes every step.
const pins = [];
let tool = null;
for (const line of README.split('\n')) {
  const text = line.trim();
  if (text.startsWith('```') || text.startsWith('- ')) tool = null;
  if (text.startsWith('tool: spec-')) tool = text.slice('tool: '.length);
  if (text.startsWith('version: ') && tool !== null) pins.push({ tool, version: text.slice('version: '.length) });
}
if (pins.length === 0) {
  console.error('latest: README.md pins no release, and this check reads nothing');
  process.exit(2);
}

const latest = new Map();
for (const name of new Set(pins.map((pin) => pin.tool))) {
  const url = `https://registry.npmjs.org/@spec-family%2f${name}/latest`;
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'spec-family-action' } });
  if (!response.ok) {
    console.error(`latest: ${url} answered ${response.status}`);
    process.exit(2);
  }
  latest.set(name, (await response.json()).version);
}

const stale = pins.filter((pin) => pin.version !== latest.get(pin.tool));
for (const [name, version] of latest) console.log(`${name}: npm's latest is ${version}`);
for (const pin of stale) console.log(`README.md pins ${pin.tool} ${pin.version}, and npm's latest is ${latest.get(pin.tool)}`);
if (stale.length > 0) process.exit(1);
console.log(`README.md pins ${pins.length} release(s), each npm's latest`);
