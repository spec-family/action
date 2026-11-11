// action.yml, the workflows and the README, held to each other and to the
// family's rules: every action named by commit with its version beside it,
// every input and output in the README as action.yml has it, each job on an
// image that does not move, and the README's examples at this release.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const ACTION = read('action.yml');
const README = read('README.md');
const VERSION = JSON.parse(read('package.json')).version;
const WORKFLOWS = readdirSync(join(ROOT, '.github', 'workflows'))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name: `.github/workflows/${name}`, text: read(`.github/workflows/${name}`) }));

/** The family's short sentence, as the maintainer confirmed it on 2026-11-10. */
const SENTENCE = 'Hold your code, and the agents that write it, to what your Markdown says.';

/** Every `uses:` in `text`, with where it is. */
function usesOf(text, file) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const written = /^\s*(?:-\s+)?uses:\s+(\S.*?)\s*$/.exec(line)?.[1];
    return written === undefined ? [] : [{ where: `${file}:${index + 1}`, written }];
  });
}

/** `owner/action@commit # vX.Y.Z`, or null. */
const pinned = (written) => /^[\w.-]+(?:\/[\w.-]+)+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(written);

/** The keys of a top-level map in action.yml, such as its inputs. */
function keysOf(map) {
  const block = new RegExp(`^${map}:\\n((?:  .*\\n|\\n)*)`, 'm').exec(ACTION)?.[1] ?? '';
  return [...block.matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1]);
}

/** The first column of the README table under `heading`, without its backticks. */
function tableOf(heading) {
  const section = README.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? '';
  return [...section.matchAll(/^\| `([\w-]+)` \|/gm)].map((match) => match[1]);
}

describe('the action', () => {
  it('has a Marketplace name that is not the organization, a description and a brand', () => {
    const name = /^name: (.+)$/m.exec(ACTION)?.[1];
    assert.ok(name !== undefined && name.toLowerCase().replace(/\s+/g, '-') !== 'spec-family', name);
    assert.equal(/^description: (.+)$/m.exec(ACTION)?.[1], SENTENCE);
    assert.match(ACTION, /^branding:\n {2}icon: [\w-]+\n {2}color: (white|black|yellow|blue|green|orange|red|purple|gray-dark)\n/m);
  });

  it('hands every input to its script as a variable, and none as text in the script', () => {
    const inputs = keysOf('inputs');
    const handed = [...ACTION.matchAll(/^ {8}SPEC_FAMILY_ACTION_(\w+): \$\{\{ inputs\.([\w-]+) \}\}$/gm)];
    assert.deepEqual(handed.map((match) => match[2]).sort(), inputs.filter((input) => input !== 'node-version').sort());
    for (const match of handed) assert.equal(match[1], match[2].toUpperCase().replace(/-/g, '_'));
    const script = /^ {6}run: (.+)$/m.exec(ACTION)?.[1];
    assert.equal(script, 'node "$GITHUB_ACTION_PATH/src/main.mjs"');
  });

  it("takes each output from the script's step", () => {
    for (const output of keysOf('outputs')) assert.match(ACTION, new RegExp(`value: \\$\\{\\{ steps\\.run\\.outputs\\.${output} \\}\\}`));
  });
});

describe('the pins', () => {
  it('name every action the action and the workflows use by commit, with its version', () => {
    const uses = [usesOf(ACTION, 'action.yml'), ...WORKFLOWS.map(({ name, text }) => usesOf(text, name))].flat();
    assert.ok(uses.length > 0);
    assert.deepEqual(uses.filter(({ written }) => written !== './' && !pinned(written)).map(({ where, written }) => `${where}: ${written}`), []);
  });

  it('name every other action in the README by commit, and this one at this release', () => {
    const uses = usesOf(README, 'README.md');
    const ours = uses.filter(({ written }) => written.startsWith('spec-family/action@'));
    assert.ok(ours.length >= 4);
    assert.deepEqual(ours.filter(({ written }) => written !== `spec-family/action@v${VERSION}` && written !== `spec-family/action@<that commit> # v${VERSION}`).map(({ where, written }) => `${where}: ${written}`), []);
    assert.deepEqual(uses.filter(({ written }) => !written.startsWith('spec-family/action@') && !pinned(written)).map(({ where, written }) => `${where}: ${written}`), []);
    assert.deepEqual([...README.matchAll(/refs\/tags\/v([\d.]+)/g)].map((match) => match[1]), [VERSION]);
  });

  it('give the README the commits the workflows run', () => {
    const run = new Map(WORKFLOWS.flatMap(({ name, text }) => usesOf(text, name)).map(({ written }) => written.split('@')));
    for (const { where, written } of usesOf(README, 'README.md')) {
      const [action, pin] = written.split('@');
      if (run.has(action)) assert.equal(pin, run.get(action), where);
    }
  });
});

describe('the README', () => {
  it("lists action.yml's inputs and outputs, in its order", () => {
    assert.deepEqual(tableOf('Inputs'), keysOf('inputs'));
    assert.deepEqual(tableOf('Outputs'), keysOf('outputs'));
  });

  it("leads with the family's sentence", () => {
    assert.equal(README.split('\n')[2], `**${SENTENCE}**`);
  });

  it('shows one job for each tool', () => {
    for (const tool of ['spec-guard', 'spec-graph', 'spec-brief', 'spec-harness']) assert.match(README, new RegExp(`^ {10}tool: ${tool}$`, 'm'), tool);
  });

  it('never has npx run a tool by a name without its scope', () => {
    assert.deepEqual(README.match(/npx\b.*/g) ?? [], []);
  });
});

describe('the workflows', () => {
  it('read the repository and write nothing', () => {
    for (const { name, text } of WORKFLOWS) assert.match(text, /^permissions:\n {2}contents: read\n\n/m, name);
  });

  it('run each job on an image that does not move', () => {
    for (const { name, text } of WORKFLOWS) {
      const labels = [...text.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((match) => match[1]);
      assert.ok(labels.length > 0, name);
      assert.deepEqual(labels.filter((label) => label !== 'ubuntu-24.04'), [], name);
    }
  });

  it('check out without leaving a credential behind', () => {
    for (const { name, text } of WORKFLOWS) {
      const checkouts = text.split(/\r?\n/).filter((line) => /uses: actions\/checkout@/.test(line)).length;
      assert.equal((text.match(/persist-credentials: false/g) ?? []).length, checkouts, name);
    }
  });
});
