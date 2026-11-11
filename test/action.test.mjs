// The action's script, against a stand-in for a tool: what it runs, where it
// finds the tool, what it refuses, and the exit code and outputs it leaves.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PREFIX, Refusal, childEnv, engineFault, findProjectCopy, install, readInputs } from '../src/action.mjs';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'spec-family-action-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
/** A fresh directory below the scratch one. */
function directory() {
  const path = join(scratch, String(made++));
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * A stand-in for a tool: it prints the arguments it was given and the
 * action's variables it can see, writes a SARIF document for --format sarif,
 * and exits as FAKE_EXIT says, or FAKE_SARIF_EXIT for the SARIF run.
 */
const FAKE = `
const args = process.argv.slice(2);
const sarif = args.includes('sarif');
if (sarif) {
  process.stdout.write(JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'fake' } }, results: [] }] }));
} else {
  const seen = Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('SPEC_FAMILY_ACTION_'));
  process.stdout.write('argv ' + JSON.stringify(args) + '\\n' + 'cwd ' + process.cwd() + '\\n' + 'seen ' + JSON.stringify(seen) + '\\n');
}
const code = sarif && process.env.FAKE_SARIF_EXIT !== undefined ? process.env.FAKE_SARIF_EXIT : process.env.FAKE_EXIT;
process.exitCode = Number(code ?? 0);
`;

/** Installs the stand-in as `tool` in `root`'s node_modules, as a project would. */
function installFake(root, tool = 'spec-guard', manifest = {}) {
  const home = join(root, 'node_modules', '@spec-family', tool);
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', `${tool}.js`), FAKE);
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: `@spec-family/${tool}`, version: '1.2.3', bin: { [tool]: `bin/${tool}.js` }, engines: { node: '>=22' }, ...manifest }));
  return home;
}

/** The inputs as action.yml hands them over. */
function inputs(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [PREFIX + key, value]));
}

/** Runs the action's entry in `cwd` and returns its exit code, its output and its step outputs. */
function action(cwd, values, env = {}) {
  const output = join(directory(), 'output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [MAIN], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...inputs(values), GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, RUNNER_TEMP: directory(), ...env },
  });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

/** The arguments the stand-in printed. */
const argvOf = (stdout) => JSON.parse(/^argv (.*)$/m.exec(stdout)?.[1] ?? 'null');

describe('the inputs', () => {
  const cwd = directory();
  const read = (values) => readInputs(inputs({ TOOL: 'spec-guard', ...values }), cwd);

  it('take one of the four tools, and nothing else', () => {
    for (const tool of ['spec-brief', 'spec-graph', 'spec-guard', 'spec-harness']) assert.equal(read({ TOOL: tool }).tool, tool);
    assert.throws(() => read({ TOOL: '' }), { message: /tool is "", which names no tool: give one of spec-brief, spec-graph, spec-guard, spec-harness/ });
    assert.throws(() => read({ TOOL: '@spec-family/spec-guard' }), { message: /which is not a spec-family tool/ });
    assert.throws(() => read({ TOOL: 'spec-harness ' + 'x' }), Refusal);
  });

  it('take a command as one word, and options under args', () => {
    assert.equal(read({ COMMAND: 'claims' }).command, 'claims');
    assert.equal(read({}).command, '');
    assert.throws(() => read({ COMMAND: '--strict' }), { message: /command is "--strict", which is not a command of spec-guard: give the command alone/ });
    assert.throws(() => read({ COMMAND: 'claims --strict' }), Refusal);
  });

  it('read args one to a line, as written, without the blank lines', () => {
    assert.deepEqual(read({ ARGS: '"docs/**/*.md"\r\n\n  --max  \n5\n' }).args, ['"docs/**/*.md"', '--max', '5']);
    assert.deepEqual(read({ ARGS: 'docs/**/*.md' }).args, ['docs/**/*.md']);
    assert.deepEqual(read({}).args, []);
  });

  it('take one exact release as the version, and say how to write one', () => {
    for (const version of ['0.33.1', '10.0.0', '0.0.0-stage', '1.0.0-rc.1']) assert.equal(read({ VERSION: version }).version, version);
    assert.equal(read({}).version, '');
    assert.throws(() => read({ VERSION: 'v0.33.1' }), { message: /give the release without the v, as 0\.33\.1/ });
    for (const version of ['latest', '^0.33.0', '0.33', '0.33.x', '>=0.33.1', '0.33.1 || 0.34.0', '0.33.1;id']) {
      assert.throws(() => read({ VERSION: version }), { message: /names no single release of spec-guard: give one release exactly/ }, version);
    }
  });

  it('resolve the working directory and the SARIF path from the workspace', () => {
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    const read2 = read({ WORKING_DIRECTORY: 'sub', SARIF: 'out/x.sarif' });
    assert.equal(read2.workingDirectory, join(cwd, 'sub'));
    assert.equal(read2.sarif, join(cwd, 'out', 'x.sarif'));
    assert.equal(read({}).workingDirectory, cwd);
    assert.equal(read({}).sarif, '');
    assert.throws(() => read({ WORKING_DIRECTORY: 'nowhere' }), { message: /working-directory is "nowhere", which is not a directory/ });
    assert.throws(() => read({ SARIF: 'sub' }), { message: /sarif is "sub", which is a directory/ });
  });

  it('take annotations as true or false, true unless given', () => {
    assert.equal(read({}).annotations, true);
    assert.equal(read({ ANNOTATIONS: 'false' }).annotations, false);
    assert.throws(() => read({ ANNOTATIONS: 'yes' }), { message: /annotations is "yes": give true or false/ });
  });

  it('refuse a format in args where the action sets one', () => {
    for (const arg of ['--format', '--format=json', '--json']) {
      assert.throws(() => read({ ARGS: arg }), { message: new RegExp(`args holds ${arg}, and the action sets the format for annotations`) });
      assert.throws(() => read({ ARGS: arg, ANNOTATIONS: 'false', SARIF: 'x.sarif' }), { message: /the action sets the format for sarif:/ });
      assert.deepEqual(read({ ARGS: arg, ANNOTATIONS: 'false' }).args, [arg]);
    }
  });
});

describe('the Node a tool needs', () => {
  it('is read from a >= range, and a Node below it is said', () => {
    assert.equal(engineFault('>=22', '20.18.1'), 'it needs Node >=22, and this job runs Node 20.18.1');
    assert.equal(engineFault('>=22.6', '22.5.9'), 'it needs Node >=22.6, and this job runs Node 22.5.9');
    assert.equal(engineFault('>=22', '22.0.0'), null);
    assert.equal(engineFault('>=22', '24.11.0'), null);
    assert.equal(engineFault('>=22.6.0', '23.0.0'), null);
    assert.equal(engineFault(' >= 22 ', 'v21.7.3'), 'it needs Node >= 22, and this job runs Node v21.7.3');
  });

  it('is left to the tool when the range has another shape, or none', () => {
    assert.equal(engineFault('^22 || ^24', '20.0.0'), null);
    assert.equal(engineFault(null, '20.0.0'), null);
  });
});

describe("the project's install", () => {
  it('is found here or in a directory above, as Node finds a package', () => {
    const root = directory();
    const home = installFake(root);
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    for (const from of [root, join(root, 'a', 'b')]) {
      const copy = findProjectCopy('spec-guard', from);
      assert.equal(copy?.source, 'project');
      assert.equal(copy?.version, '1.2.3');
      assert.equal(copy?.script, join(home, 'bin', 'spec-guard.js'));
      assert.equal(copy?.engines, '>=22');
    }
    assert.equal(findProjectCopy('spec-graph', join(root, 'a')), null);
  });

  it('is refused when its package.json names no command', () => {
    const root = directory();
    installFake(root, 'spec-guard', { bin: {} });
    assert.throws(() => findProjectCopy('spec-guard', root), { message: /names no version or no "spec-guard" command/ });
  });
});

describe('a copy the action fetches', () => {
  /** An npm that installs `packages` and answers the signature audit with `audit`. */
  function fakeNpm({ packages = ['node_modules/@spec-family/spec-guard'], audit = { status: 0, stdout: '{ "invalid": [], "missing": [] }' }, install: installed = { status: 0 }, version = '0.33.1' } = {}) {
    const calls = [];
    const npm = (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'install') {
        if (installed.status === 0) {
          installFake(cwd, 'spec-guard', { version });
          writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(['', ...packages].map((key) => [key, {}])) }));
        }
        return { stdout: '', stderr: '', ...installed };
      }
      return { stderr: '', ...audit };
    };
    return { npm, calls };
  }

  it('is the exact release, scoped, with no install script, verified, in a directory of its own', () => {
    const base = directory();
    const { npm, calls } = fakeNpm();
    const copy = install('spec-guard', '0.33.1', base, npm);
    assert.deepEqual(calls.map((call) => call.args), [
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '@spec-family/spec-guard@0.33.1'],
      ['audit', 'signatures', '--json'],
    ]);
    assert.equal(calls[0].cwd, join(base, 'spec-guard-0.33.1'));
    assert.deepEqual(JSON.parse(readFileSync(join(base, 'spec-guard-0.33.1', 'package.json'), 'utf8')), { private: true });
    assert.equal(copy.source, 'action');
    assert.equal(copy.version, '0.33.1');
  });

  it('is not run when it brought another package with it', () => {
    const { npm } = fakeNpm({ packages: ['node_modules/@spec-family/spec-guard', 'node_modules/left-pad'] });
    assert.throws(() => install('spec-guard', '0.33.1', directory(), npm), { message: /came with node_modules\/left-pad, and no release of the family depends on another package/ });
  });

  it('is not run when npm cannot verify its signature', () => {
    for (const audit of [
      { status: 1, stdout: '{ "invalid": [{}], "missing": [] }' },
      { status: 0, stdout: '{ "invalid": [], "missing": [{}] }' },
      { status: 1, stdout: '', stderr: 'npm error found no dependencies to audit that were installed from a supported registry' },
      { status: 0, stdout: 'not JSON' },
    ]) {
      const { npm } = fakeNpm({ audit });
      assert.throws(() => install('spec-guard', '0.33.1', directory(), npm), { message: /npm cannot verify the registry's signature of @spec-family\/spec-guard@0\.33\.1/ });
    }
  });

  it('is not run when npm fails, or installs another version', () => {
    assert.throws(() => install('spec-guard', '0.33.1', directory(), fakeNpm({ install: { status: 1, stderr: 'npm error notarget No matching version' } }).npm), { message: /npm could not install @spec-family\/spec-guard@0\.33\.1 \(exit 1\): npm error notarget No matching version/ });
    assert.throws(() => install('spec-guard', '0.33.1', directory(), fakeNpm({ version: '0.33.2' }).npm), { message: /npm installed spec-guard 0\.33\.2 where 0\.33\.1 was asked for/ });
  });

  it('is only ever a release of a family tool', () => {
    assert.throws(() => install('left-pad', '1.0.0', directory(), fakeNpm().npm), Refusal);
    assert.throws(() => install('spec-guard', 'latest', directory(), fakeNpm().npm), Refusal);
  });
});

describe('the environment a tool runs in', () => {
  it("is the job's, without the action's inputs", () => {
    assert.deepEqual(childEnv({ PATH: '/bin', SPEC_FAMILY_ACTION_TOOL: 'spec-guard', spec_family_action_args: 'x', SPEC_BRIEF: '001' }), { PATH: '/bin', SPEC_BRIEF: '001' });
  });
});

describe('a run', () => {
  const project = directory();
  installFake(project);
  mkdirSync(join(project, 'sub'), { recursive: true });

  it("runs the project's install with the command, the args and --format github, in the working directory", () => {
    const run = action(project, { TOOL: 'spec-guard', COMMAND: 'claims', ARGS: 'docs/**/*.md\n--strict', WORKING_DIRECTORY: 'sub' });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.deepEqual(argvOf(run.stdout), ['claims', 'docs/**/*.md', '--strict', '--format', 'github']);
    assert.match(run.stdout, new RegExp(`^cwd ${join(project, 'sub').replace(/\\/g, '\\\\')}$`, 'm'));
    assert.match(run.stdout, /^spec-family\/action: spec-guard 1\.2\.3, the project's install in node_modules[/\\]@spec-family[/\\]spec-guard: spec-guard claims "docs\/\*\*\/\*\.md" --strict --format github$/m);
    assert.deepEqual(run.outputs, { 'exit-code': '0', sarif: '', version: '1.2.3', source: 'project' });
  });

  it("hides the action's inputs from the tool", () => {
    assert.match(action(project, { TOOL: 'spec-guard' }).stdout, /^seen \[\]$/m);
  });

  it('runs the command as args give it when annotations is false', () => {
    const run = action(project, { TOOL: 'spec-guard', ARGS: '--format\nmarkdown', ANNOTATIONS: 'false' });
    assert.deepEqual(argvOf(run.stdout), ['--format', 'markdown']);
  });

  it("passes the tool's exit code through, whatever it is", () => {
    for (const code of [0, 1, 2, 3]) {
      const run = action(project, { TOOL: 'spec-guard' }, { FAKE_EXIT: String(code) });
      assert.equal(run.code, code);
      assert.equal(run.outputs['exit-code'], String(code));
    }
  });

  it('writes SARIF from a second run, and names the file', () => {
    for (const code of [0, 1]) {
      const run = action(project, { TOOL: 'spec-guard', COMMAND: 'claims', SARIF: `out/${code}/claims.sarif` }, { FAKE_EXIT: String(code) });
      const file = join(project, 'out', String(code), 'claims.sarif');
      assert.equal(run.code, code);
      assert.equal(run.outputs.sarif, file);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, '2.1.0');
      assert.match(run.stdout, /^spec-family\/action: SARIF to out[/\\]\d[/\\]claims\.sarif: spec-guard claims --format sarif$/m);
    }
  });

  it('writes no SARIF after a run that cannot be trusted', () => {
    const run = action(project, { TOOL: 'spec-guard', SARIF: 'out/untrusted.sarif' }, { FAKE_EXIT: '2' });
    assert.equal(run.code, 2);
    assert.equal(run.outputs.sarif, '');
    assert.equal(existsSync(join(project, 'out', 'untrusted.sarif')), false);
  });

  it('exits 2 when the SARIF run and the first disagree', () => {
    const run = action(project, { TOOL: 'spec-guard', SARIF: 'out/disagree.sarif' }, { FAKE_EXIT: '1', FAKE_SARIF_EXIT: '0' });
    assert.equal(run.code, 2);
    assert.deepEqual({ ...run.outputs, version: undefined }, { 'exit-code': '2', sarif: '', version: undefined, source: 'project' });
    assert.match(run.stdout, /^::error title=spec-family\/action::spec-guard exited 1 for the first run and 0 for SARIF, on one tree: the two answers disagree, and neither is trusted$/m);
  });

  it("runs the project's install when version names another, and says so", () => {
    const run = action(project, { TOOL: 'spec-guard', VERSION: '1.2.4' });
    assert.equal(run.code, 0);
    assert.equal(run.outputs.version, '1.2.3');
    assert.match(run.stdout, /^::warning title=spec-family\/action::version asks for spec-guard 1\.2\.4, and the project installed 1\.2\.3: the project's install runs, since its lockfile decides/m);
  });

  it('says nothing of a version that names the install', () => {
    assert.doesNotMatch(action(project, { TOOL: 'spec-guard', VERSION: '1.2.3' }).stdout, /::warning/);
  });

  it('refuses, with exit 2, when there is no install and no version', () => {
    const run = action(directory(), { TOOL: 'spec-guard' });
    assert.equal(run.code, 2);
    assert.deepEqual(run.outputs, { 'exit-code': '2', sarif: '', version: '', source: '' });
    assert.match(run.stdout, /^::error title=spec-family\/action::the project has not installed @spec-family\/spec-guard \(no node_modules\/@spec-family\/spec-guard in .* or above it\), and version is empty: install it in the project before this step, or give version an exact release to fetch$/m);
  });

  it('refuses, with exit 2, a tool the job\'s Node cannot run, rather than crash it', () => {
    const old = directory();
    installFake(old, 'spec-graph', { engines: { node: '>=99' } });
    const run = action(old, { TOOL: 'spec-graph' });
    assert.equal(run.code, 2);
    assert.match(run.stdout, /::error title=spec-family\/action::spec-graph 1\.2\.3 cannot run here: it needs Node >=99, and this job runs Node .*\. Give node-version, or set up Node before this step$/m);
    assert.equal(argvOf(run.stdout), null);
  });

  it('refuses each input it cannot act on, with exit 2 and one annotation', () => {
    const run = action(project, { TOOL: 'spec-guard', VERSION: 'latest' });
    assert.equal(run.code, 2);
    assert.equal(run.outputs['exit-code'], '2');
    assert.equal(run.stdout.split('\n').filter((line) => line.startsWith('::error')).length, 1);
  });

  it('keeps a message that holds a line break on one annotation', () => {
    const run = action(project, { TOOL: 'spec-guard', COMMAND: 'a\nb' });
    assert.match(run.stdout, /^::error title=spec-family\/action::command is "a%0Ab", which is not a command/m);
  });

  it('writes plain lines on stderr outside a job', () => {
    const run = action(project, { TOOL: '' }, { GITHUB_ACTIONS: '' });
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^spec-family\/action: error: tool is "", which names no tool/m);
  });
});
