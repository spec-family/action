// @ts-check
/** The action's entry: action.yml runs this file with the job's Node. */

import { main, reporter } from './action.mjs';

let code;
try {
  code = main(process.env, process.cwd());
} catch (error) {
  // An error the action did not expect is no answer from the tool: 2, never
  // the 1 that Node exits with, which would read as findings.
  reporter(process.env).error(`unexpected error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  code = 2;
}
process.exitCode = code;
