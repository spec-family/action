# Changelog

The action's own releases. A release of a tool needs none: the tool's
version is an input, or the project's lockfile.

## 0.1.0 - unreleased

The first release.

- One composite action for spec-guard, spec-graph, spec-brief and
  spec-harness: `tool`, `command`, `args` (one to a line), `version`,
  `working-directory`, `annotations`, `sarif` and `node-version` in;
  `exit-code`, `sarif`, `version` and `source` out.
- The project's install runs when there is one. Otherwise the exact release
  `version` names is installed with `npm install --ignore-scripts` into a
  directory of the action's own, run only if it brought no other package and
  `npm audit signatures` verifies it.
- Findings annotate the pull request (`--format github`), and a second run
  can write SARIF for `github/codeql-action/upload-sarif`; two runs that
  disagree exit 2.
- The tool's exit code is the step's: 0 clean, 1 found something, 2 the run
  cannot be trusted. An input the action cannot act on, or a Node older than
  the tool supports, is 2 with one annotation that says what to do.
