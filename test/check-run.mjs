// Holds the steps of one self-test job to what each should have done: its
// outcome, its outputs, and the SARIF it wrote. The job hands its steps over
// as JSON in STEPS; the argument names the job.
//
// Runs on the job's Node, which in the old-node job is one the tools do not
// support, so it is written for any Node from 18 on.

import { existsSync, readFileSync } from 'node:fs';

/**
 * A SARIF document as GitHub's upload reads it, with `results` findings
 * from `driver`, each as `check` says.
 */
function sarifOf(driver, results, check = () => null) {
  return (path) => {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (document.version !== '2.1.0') return `version is ${document.version}, not 2.1.0`;
    const run = document.runs?.[0];
    if (run?.tool?.driver?.name !== driver) return `the driver is ${run?.tool?.driver?.name}, not ${driver}`;
    const found = run.results?.length;
    if (typeof results === 'number' ? found !== results : !(found >= 1)) return `it holds ${found} results, where ${results} were expected`;
    for (const result of run.results) {
      const fault = check(result);
      if (fault !== null) return fault;
    }
    return null;
  };
}

/** What each step of each job should have done. `sarif` is a path's ending, or '' for none. */
const EXPECTED = {
  fetched: {
    clean: { outcome: 'success', exit: '0', source: 'action', version: '0.33.1', sarif: 'out/clean.sarif', document: sarifOf('spec-guard', 0) },
    finding: {
      outcome: 'failure', exit: '1', source: 'action', version: '0.33.1', sarif: 'out/finding.sarif',
      document: sarifOf('spec-guard', 'some', (result) => {
        const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
        return result.ruleId === 'assert-absence' && uri === 'src/greet.js' ? null : `a result is ${result.ruleId} at ${uri}, not assert-absence at src/greet.js`;
      }),
    },
    graph: { outcome: 'failure', exit: '1', source: 'action', version: '0.24.1', sarif: '' },
    untrusted: { outcome: 'failure', exit: '2', source: 'action', version: '0.13.1', sarif: '', absent: 'out/untrusted.sarif' },
    refused: { outcome: 'failure', exit: '2', source: '', version: '', sarif: '' },
  },
  project: {
    premises: { outcome: 'success', exit: '0', source: 'project', version: '0.24.1', sarif: 'premises.sarif', document: sarifOf('spec-harness', 0) },
    lint: { outcome: 'success', exit: '0', source: 'project', version: '0.13.1', sarif: '' },
    pinned: { outcome: 'success', exit: '0', source: 'project', version: '0.33.1', sarif: '' },
  },
  'old-node': {
    old: { outcome: 'failure', exit: '2', source: 'action', version: '0.33.1', sarif: '' },
  },
};

const job = process.argv[2];
const expected = EXPECTED[job];
if (expected === undefined) {
  console.error(`check-run: "${job}" is not a job of the self-test: give one of ${Object.keys(EXPECTED).join(', ')}`);
  process.exit(2);
}

const steps = JSON.parse(process.env.STEPS ?? '{}');
const faults = [];
for (const [id, want] of Object.entries(expected)) {
  const before = faults.length;
  const step = steps[id];
  if (step === undefined) {
    faults.push(`${id}: the step did not run`);
    continue;
  }
  const outputs = step.outputs ?? {};
  const got = { outcome: step.outcome, exit: outputs['exit-code'], source: outputs.source, version: outputs.version };
  for (const key of ['outcome', 'exit', 'source', 'version']) {
    if (got[key] !== want[key]) faults.push(`${id}: ${key} is "${got[key]}", not "${want[key]}"`);
  }
  const sarif = (outputs.sarif ?? '').replace(/\\/g, '/');
  if (want.sarif === '' ? sarif !== '' : !sarif.endsWith(`/${want.sarif}`)) {
    faults.push(`${id}: sarif is "${sarif}", where ${want.sarif === '' ? 'none' : `a path ending ${want.sarif}`} was expected`);
  } else if (want.document !== undefined) {
    const fault = want.document(outputs.sarif);
    if (fault !== null) faults.push(`${id}: the SARIF ${fault}`);
  }
  if (want.absent !== undefined && existsSync(want.absent)) faults.push(`${id}: ${want.absent} was written, after a run that cannot be trusted`);
  if (faults.length === before) console.log(`${id}: ${got.outcome}, exit ${got.exit}, ${got.source || 'no copy'} ${got.version}`.trimEnd());
}

for (const fault of faults) console.log(`::error title=self-test ${job}::${fault}`);
process.exit(faults.length === 0 ? 0 : 1);
