// @ts-check
/**
 * Runs one spec-family tool in a GitHub Actions job, for action.yml.
 *
 * The copy that runs is the project's own when it installed one: which release
 * a project runs is its lockfile's to say (spec-harness ADR-0012 gives the
 * reasons). Otherwise the action fetches the exact release `version` names,
 * scoped, into a directory of its own, with no install script run, and runs
 * nothing that brought another package with it or that npm cannot verify.
 *
 * The tool's exit code is the action's: 0 clean, 1 found something, 2 the run
 * cannot be trusted. An input the action cannot act on is 2 as well, said in
 * one line, never a run that reads it as if it had not been given.
 *
 * Written for whatever Node the runner has, old ones included, so that a job
 * on a Node the tool does not support is told so rather than sent a crash.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const TOOLS = ['spec-brief', 'spec-graph', 'spec-guard', 'spec-harness'];

export const SCOPE = '@spec-family';

/** The prefix of the variables action.yml hands its inputs in; none reaches the tool. */
export const PREFIX = 'SPEC_FAMILY_ACTION_';

/** One release: major, minor and patch, and a pre-release after a hyphen. */
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const COMMAND = /^[a-z][a-z0-9-]*$/;

/** What the action says before each line of its own, so that no line of its own reads as a workflow command. */
const NAME = 'spec-family/action';

/** An input or a state the action cannot run the tool from: exit 2, and this message. */
export class Refusal extends Error {}

/**
 * @typedef {object} Inputs
 * @property {string} tool
 * @property {string} command
 * @property {string[]} args
 * @property {string} version
 * @property {string} workingDirectory absolute
 * @property {boolean} annotations
 * @property {string} sarif absolute, or '' for none
 */

/**
 * The inputs as action.yml hands them over, read and checked.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd where relative paths start: the job's workspace
 * @returns {Inputs}
 */
export function readInputs(env, cwd) {
  /** @param {string} name */
  const input = (name) => (env[PREFIX + name] ?? '').trim();

  const tool = input('TOOL');
  if (!TOOLS.includes(tool)) {
    const named = tool === '' ? 'names no tool' : 'is not a spec-family tool';
    throw new Refusal(`tool is "${tool}", which ${named}: give one of ${TOOLS.join(', ')}`);
  }

  const command = input('COMMAND');
  if (command !== '' && !COMMAND.test(command)) {
    throw new Refusal(`command is "${command}", which is not a command of ${tool}: give the command alone, as "claims" or "check", and options under args, one to a line`);
  }

  const args = (env[PREFIX + 'ARGS'] ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const version = input('VERSION');
  if (version !== '' && !RELEASE.test(version)) {
    const hint = /^v\d/.test(version) && RELEASE.test(version.slice(1))
      ? `give the release without the v, as ${version.slice(1)}`
      : 'give one release exactly, as 0.33.1, never a range or a tag';
    throw new Refusal(`version is "${version}", which names no single release of ${tool}: ${hint}`);
  }

  const workingDirectory = resolve(cwd, input('WORKING_DIRECTORY') || '.');
  if (!isDirectory(workingDirectory)) {
    throw new Refusal(`working-directory is "${input('WORKING_DIRECTORY')}", which is not a directory`);
  }

  const annotationsText = input('ANNOTATIONS') || 'true';
  if (annotationsText !== 'true' && annotationsText !== 'false') {
    throw new Refusal(`annotations is "${annotationsText}": give true or false`);
  }
  const annotations = annotationsText === 'true';

  const sarifText = input('SARIF');
  const sarif = sarifText === '' ? '' : resolve(cwd, sarifText);
  if (sarif !== '' && isDirectory(sarif)) {
    throw new Refusal(`sarif is "${sarifText}", which is a directory: give the path of the file to write`);
  }

  const format = args.find((arg) => arg === '--json' || arg === '--format' || arg.startsWith('--format='));
  if (format !== undefined && (annotations || sarif !== '')) {
    const sets = [annotations ? 'annotations' : '', sarif !== '' ? 'sarif' : ''].filter(Boolean).join(' and ');
    throw new Refusal(`args holds ${format}, and the action sets the format for ${sets}: set annotations to false and leave sarif empty to give a format of your own`);
  }

  for (const [name, value] of /** @type {const} */ ([['working-directory', workingDirectory], ['sarif', sarif]])) {
    if (/[\r\n]/.test(value)) throw new Refusal(`${name} holds a line break`);
  }

  return { tool, command, args, version, workingDirectory, annotations, sarif };
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @typedef {object} Copy
 * @property {'project' | 'action'} source who installed it
 * @property {string} directory the package's directory
 * @property {string} version
 * @property {string} script the file its command runs
 * @property {string | null} engines the Node versions it supports, as package.json says
 */

/**
 * The tool as the project installed it, looked for as Node looks for a
 * package: in `node_modules` here, then in each directory above. Or null.
 *
 * @param {string} tool
 * @param {string} from
 * @returns {Copy | null}
 */
export function findProjectCopy(tool, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const manifest = join(directory, 'node_modules', SCOPE, tool, 'package.json');
    if (existsSync(manifest)) return readCopy(manifest, tool, 'project');
    if (dirname(directory) === directory) return null;
  }
}

/**
 * @param {string} manifest the package's package.json
 * @param {string} tool
 * @param {'project' | 'action'} source
 * @returns {Copy}
 */
export function readCopy(manifest, tool, source) {
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (error) {
    throw new Refusal(`${manifest} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.[tool];
  if (typeof bin !== 'string' || typeof pkg?.version !== 'string') {
    throw new Refusal(`${manifest} names no version or no "${tool}" command, so it is not a copy of ${SCOPE}/${tool} the action can run`);
  }
  const directory = dirname(manifest);
  const engines = typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  return { source, directory, version: pkg.version, script: join(directory, bin), engines };
}

/**
 * @typedef {(args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string }} Npm
 */

/** @type {Npm} */
export function npm(args, cwd) {
  // npm is a .cmd file on Windows, which only a shell starts. Every argument
  // the action gives it is checked to hold no character a shell reads.
  const windows = process.platform === 'win32';
  const result = windows
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, shell: true, encoding: 'utf8', env: childEnv(process.env) })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', env: childEnv(process.env) });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? String(result.error.message) : (result.stderr ?? ''),
  };
}

/**
 * Fetches `@spec-family/<tool>@<version>` into a directory of its own below
 * `base`, with no install script run, and returns it if it can be run: it
 * brought no other package with it, and npm verifies the registry's
 * signature and attestations for it.
 *
 * @param {string} tool
 * @param {string} version
 * @param {string} base
 * @param {Npm} run
 * @returns {Copy}
 */
export function install(tool, version, base, run = npm) {
  const spec = `${SCOPE}/${tool}@${version}`;
  if (!TOOLS.includes(tool) || !RELEASE.test(version)) throw new Refusal(`${spec} is not a release the action fetches`);
  const directory = join(base, `${tool}-${version}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{ "private": true }\n');

  const fetched = run(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', spec], directory);
  if (fetched.status !== 0) {
    throw new Refusal(`npm could not install ${spec} (exit ${fetched.status}): ${lastLines(fetched.stderr || fetched.stdout)}`);
  }

  let packages;
  try {
    packages = Object.keys(JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')).packages ?? {});
  } catch (error) {
    throw new Refusal(`npm installed ${spec} and wrote no lockfile the action can read, so what it fetched is not known: ${error instanceof Error ? error.message : String(error)}`);
  }
  const own = `node_modules/${SCOPE}/${tool}`;
  const others = packages.filter((key) => key !== '' && key !== own);
  if (!packages.includes(own) || others.length > 0) {
    throw new Refusal(`${spec} came with ${others.join(', ') || 'no package of its name'}, and no release of the family depends on another package, so it is not run`);
  }

  const audit = run(['audit', 'signatures', '--json'], directory);
  /** @type {any} */
  let verdict = null;
  try {
    verdict = JSON.parse(audit.stdout);
  } catch {
    // Said below, with what npm wrote.
  }
  const invalid = Array.isArray(verdict?.invalid) ? verdict.invalid.length : -1;
  const missing = Array.isArray(verdict?.missing) ? verdict.missing.length : -1;
  if (audit.status !== 0 || invalid !== 0 || missing !== 0) {
    throw new Refusal(`npm cannot verify the registry's signature of ${spec} (npm audit signatures, exit ${audit.status}): ${lastLines(audit.stderr || audit.stdout)}. Behind a registry that does not sign, install the tool in the project instead`);
  }

  const copy = readCopy(join(directory, own, 'package.json'), tool, 'action');
  if (copy.version !== version) throw new Refusal(`npm installed ${tool} ${copy.version} where ${version} was asked for`);
  return copy;
}

/** @param {string} text */
function lastLines(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(' / ') || 'npm wrote nothing';
}

/**
 * Why Node `current` cannot run a package whose engines say `range`, or null.
 * Only `>=` is read, which is what every release of the family states; a
 * range of another shape is left to the tool.
 *
 * @param {string | null} range
 * @param {string} current
 * @returns {string | null}
 */
export function engineFault(range, current) {
  const match = range === null ? null : /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (match === null) return null;
  const wanted = [match[1], match[2] ?? '0', match[3] ?? '0'].map(Number);
  const running = current.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  for (let part = 0; part < 3; part++) {
    if ((running[part] ?? 0) > wanted[part]) return null;
    if ((running[part] ?? 0) < wanted[part]) return `it needs Node ${range.trim()}, and this job runs Node ${current}`;
  }
  return null;
}

/**
 * The environment the tool and npm run in: the job's, without the action's
 * own inputs.
 *
 * @param {Record<string, string | undefined>} env
 */
export function childEnv(env) {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.toUpperCase().startsWith(PREFIX)) kept[key] = value;
  }
  return kept;
}

/**
 * Runs the tool, its stdout to the job's log or into a file.
 *
 * @param {Copy} copy
 * @param {string[]} argv
 * @param {string} cwd
 * @param {'inherit' | number} stdout
 * @param {Record<string, string | undefined>} env
 * @returns {{ code: number, why?: string }}
 */
export function runTool(copy, argv, cwd, stdout, env) {
  const result = spawnSync(process.execPath, [copy.script, ...argv], { cwd, stdio: ['ignore', stdout, 'inherit'], env: childEnv(env) });
  if (result.error) return { code: 2, why: `it could not be started: ${result.error.message}` };
  if (result.status === null) return { code: 2, why: `it was ended by ${result.signal ?? 'a signal'}` };
  return { code: result.status };
}

/** @param {string} text */
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * How the action speaks: workflow commands in a job, plain lines elsewhere.
 *
 * @param {Record<string, string | undefined>} env
 */
export function reporter(env) {
  const inJob = env.GITHUB_ACTIONS === 'true';
  /** @param {'error' | 'warning'} level @param {string} message */
  const annotate = (level, message) => {
    // Written at once, so that a line of the action's never lands inside
    // the tool's output, which goes to the same log.
    if (inJob) writeSync(1, `::${level} title=${NAME}::${escapeData(message)}\n`);
    else writeSync(2, `${NAME}: ${level}: ${message}\n`);
  };
  return {
    /** @param {string} message */
    error: (message) => annotate('error', message),
    /** @param {string} message */
    warning: (message) => annotate('warning', message),
    /** @param {string} message */
    info: (message) => writeSync(1, `${NAME}: ${message}\n`),
  };
}

/**
 * Writes the step's outputs where the runner reads them; outside a job,
 * nowhere.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} outputs
 */
export function writeOutputs(env, outputs) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(outputs).map(([key, value]) => `${key}=${value.replace(/[\r\n]/g, ' ')}\n`).join(''));
}

/**
 * A path as the log shows it: from `cwd` when it is below it, whole when not.
 *
 * @param {string} cwd
 * @param {string} path
 */
function pathFrom(cwd, path) {
  const below = relative(cwd, path);
  return below === '' ? '.' : below.startsWith('..') || isAbsolute(below) ? path : below;
}

/** @param {string} arg */
const shown = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg));

/**
 * The action, start to end. Returns the exit code.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @param {{ npm?: Npm, node?: string }} [seams] for the tests: npm, and the Node version to check against
 * @returns {number}
 */
export function main(env, cwd, seams = {}) {
  const say = reporter(env);
  /** @type {Record<string, string>} */
  const outputs = { 'exit-code': '2', sarif: '', version: '', source: '' };
  try {
    const inputs = readInputs(env, cwd);
    const { tool } = inputs;

    let copy = findProjectCopy(tool, inputs.workingDirectory);
    if (copy !== null) {
      if (inputs.version !== '' && inputs.version !== copy.version) {
        say.warning(`version asks for ${tool} ${inputs.version}, and the project installed ${copy.version}: the project's install runs, since its lockfile decides. Change the lockfile, or leave version empty`);
      }
    } else if (inputs.version === '') {
      throw new Refusal(`the project has not installed ${SCOPE}/${tool} (no node_modules/${SCOPE}/${tool} in ${inputs.workingDirectory} or above it), and version is empty: install it in the project before this step, or give version an exact release to fetch`);
    } else {
      const base = join(env.RUNNER_TEMP || tmpdir(), 'spec-family-action');
      say.info(`fetching ${SCOPE}/${tool}@${inputs.version}: npm install --ignore-scripts, then npm audit signatures`);
      copy = install(tool, inputs.version, base, seams.npm);
    }
    outputs.version = copy.version;
    outputs.source = copy.source;

    const fault = engineFault(copy.engines, seams.node ?? process.versions.node);
    if (fault !== null) {
      throw new Refusal(`${tool} ${copy.version} cannot run here: ${fault}. Give node-version, or set up Node before this step`);
    }

    const base = [...(inputs.command === '' ? [] : [inputs.command]), ...inputs.args];
    const first = inputs.annotations ? [...base, '--format', 'github'] : base;
    const where = copy.source === 'project'
      ? `the project's install in ${pathFrom(cwd, copy.directory)}`
      : 'fetched and verified by the action';
    say.info(`${tool} ${copy.version}, ${where}: ${[tool, ...first].map(shown).join(' ')}`);
    const run = runTool(copy, first, inputs.workingDirectory, 'inherit', env);
    let code = run.code;
    if (run.why !== undefined) say.error(`${tool} did not run to an answer: ${run.why}`);

    if (inputs.sarif !== '' && (code === 0 || code === 1)) {
      const second = [...base, '--format', 'sarif'];
      say.info(`SARIF to ${pathFrom(cwd, inputs.sarif)}: ${[tool, ...second].map(shown).join(' ')}`);
      mkdirSync(dirname(inputs.sarif), { recursive: true });
      const file = openSync(inputs.sarif, 'w');
      let sarifRun;
      try {
        sarifRun = runTool(copy, second, inputs.workingDirectory, file, env);
      } finally {
        closeSync(file);
      }
      if (sarifRun.why !== undefined) say.error(`${tool} did not run to an answer for SARIF: ${sarifRun.why}`);
      if (sarifRun.code !== code) {
        say.error(`${tool} exited ${code} for the first run and ${sarifRun.code} for SARIF, on one tree: the two answers disagree, and neither is trusted`);
        code = 2;
      } else {
        outputs.sarif = inputs.sarif;
      }
    }

    outputs['exit-code'] = String(code);
    return code;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    say.error(error.message);
    return 2;
  } finally {
    writeOutputs(env, outputs);
  }
}
