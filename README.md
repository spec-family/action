# spec-family/action

**Hold your code, and the agents that write it, to what your Markdown says.**

One GitHub Action for the four spec-family tools. Each reads the Markdown a
repository already keeps and checks what it says against the code, the git
history and the changes an agent made:

- [spec-guard](https://github.com/spec-family/spec-guard): the rules an ADR
  states, run against the code; a claim held to its evidence.
- [spec-graph](https://github.com/spec-family/spec-graph): the documents
  against each other and the repository - references, retired decisions,
  ticked boxes, the paths an agent's instructions name.
- [spec-brief](https://github.com/spec-family/spec-brief): the briefs a round
  of agent work runs under, and which of them can run side by side.
- [spec-harness](https://github.com/spec-family/spec-harness): a round of
  agent work against its brief.

The action runs one tool's command, puts each finding on the pull request as
an annotation, can write the findings as SARIF for code scanning, and exits
as the tool does: `0` clean, `1` found something, `2` the run cannot be
trusted. The [overview](https://github.com/spec-family/spec-core/blob/main/docs/overview.md)
says which tool keeps which document true, and
[spec-family/example](https://github.com/spec-family/example) is a small
repository the four keep true, with two pull requests they turn red.

## Usage

### spec-guard, with no install

A repository that installed nothing, Node or not, names the release to run,
and the action fetches it:

```yaml
name: specs
on:
  pull_request:
  push:
    branches: [main]

jobs:
  spec-guard:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # The rules each ADR states, against the code.
      - uses: spec-family/action@v0.1.0
        with:
          tool: spec-guard
          version: 0.33.1
          node-version: '26'
      # Each claim a specification labels, against its evidence.
      - if: ${{ !cancelled() }}
        uses: spec-family/action@v0.1.0
        with:
          tool: spec-guard
          command: claims
          version: 0.33.1
```

The first step sets up Node 26 for the job, so the second needs no
`node-version`. `if: ${{ !cancelled() }}` runs each check whatever failed
before it, and the job still fails if any did.

### spec-graph, with code scanning

```yaml
jobs:
  spec-graph:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # spec-graph looks in git for the commits a checklist names, and
          # stops in a shallow clone rather than guess.
          fetch-depth: 0
          persist-credentials: false
      - id: graph
        uses: spec-family/action@v0.1.0
        with:
          tool: spec-graph
          command: check
          version: 0.24.1
          node-version: '26'
          sarif: spec-graph.sarif
      - if: ${{ !cancelled() && steps.graph.outputs.sarif != '' }}
        uses: github/codeql-action/upload-sarif@9b3254085494b55a0f7c4c2b3d2d52cc712ce370 # v4.39.1
        with:
          sarif_file: ${{ steps.graph.outputs.sarif }}
          category: spec-graph
```

The command runs twice, once for the annotations and once with
`--format sarif` for the file; a tool reads the same tree the same way each
time, and two runs that disagree exit `2`. The `sarif` output is empty after
a run that cannot be trusted, so nothing is uploaded from it. Code scanning
takes an upload in a public repository, and in a private one where GitHub
Code Security is enabled, whose job also needs `actions: read`.

### spec-brief, from the project's install

A project that installed the tools runs its own copy, the release its
lockfile pins, and needs no `version`:

```yaml
jobs:
  briefs:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '26'
          cache: npm
      - run: npm ci
      - uses: spec-family/action@v0.1.0
        with:
          tool: spec-brief
          command: lint
      - if: ${{ !cancelled() }}
        uses: spec-family/action@v0.1.0
        with:
          tool: spec-brief
          command: matrix
```

### spec-harness, on a round's pull request

spec-harness works from the project's install, with spec-brief beside it, as
its [ADR-0012](https://github.com/spec-family/spec-harness/blob/main/docs/adr/0012-one-way-into-claude-code.md)
explains: install both, and spec-guard for the premises, as
`devDependencies`. Fetched alone, it exits `2` and says spec-brief is not
installed.

```yaml
jobs:
  round:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # The audit measures a round from the base branch.
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '26'
          cache: npm
      - run: npm ci
      # Is every live brief still about something true?
      - uses: spec-family/action@v0.1.0
        with:
          tool: spec-harness
          command: premises
      # spec-harness names a round's brief from the pull request's branch:
      # brief/{id}, brief-{id}, or either after one more name and a slash. On
      # any other branch no round is under way, and the audit has no brief
      # to read.
      - if: >-
          ${{ !cancelled() && github.event_name == 'pull_request' && (
          startsWith(github.head_ref, 'brief/') || startsWith(github.head_ref, 'brief-') ||
          contains(github.head_ref, '/brief/') || contains(github.head_ref, '/brief-')) }}
        uses: spec-family/action@v0.1.0
        with:
          tool: spec-harness
          command: audit
```

A command that reports no findings, such as `spec-harness doctor` or
`spec-graph query`, takes no `--format github`: give it `annotations: false`.

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `tool` | (required) | `spec-guard`, `spec-graph`, `spec-brief` or `spec-harness`. |
| `command` | none | The tool's command, such as `claims`, `check`, `lint` or `premises`. Without one the tool runs its default command. |
| `args` | none | The command's arguments and options, one to a line. Nothing splits them on spaces and no shell reads them, so a glob reaches the tool as written. |
| `version` | none | The exact release to fetch, such as `0.33.1`, when the project has not installed the tool. Never a range or a tag. The project's install runs whenever there is one, and a `version` that names another release is said in a warning. |
| `working-directory` | `.` | Where the tool runs, from the workspace. |
| `annotations` | `true` | `true` adds `--format github`, so each finding annotates the pull request; `false` runs the command as `args` give it. |
| `sarif` | none | A path, from the workspace, to write the findings to as SARIF 2.1.0. The command runs a second time, with `--format sarif`. |
| `node-version` | none | A Node version for `actions/setup-node` to set up first, which stays set for the rest of the job. Without one the action uses the job's Node, which must be one the tool supports: Node 22 or later. |

`args` takes a block, one argument to a line:

```yaml
      - uses: spec-family/action@v0.1.0
        with:
          tool: spec-guard
          version: 0.33.1
          args: |
            docs/adr/*.md
            --strict
```

With `annotations` or `sarif`, the action sets `--format`, and `args` that
hold one are refused. Annotations and SARIF name each file from the
directory the tool runs in, and GitHub places them from the repository's
root: run from the root for them to land on the right lines.

## Outputs

| Output | What it is |
| --- | --- |
| `exit-code` | The tool's exit code, which is the step's too: `0` clean, `1` found something, `2` the run cannot be trusted. |
| `sarif` | The SARIF file's absolute path, when `sarif` asked for one and the run answered with `0` or `1`; empty otherwise. |
| `version` | The release of the tool that ran. |
| `source` | Whose copy ran: `project` for the project's install, `action` for one the action fetched. |

A step that exits `1` or `2` fails the job, as the tool decides. To read the
outputs and decide yourself, give the step an `id` and
`continue-on-error: true`.

## What runs

- **The project's copy first.** The action looks for
  `node_modules/@spec-family/<tool>` in the working directory and each
  directory above it, as Node looks for a package, and runs that copy with
  the job's Node. Which release a project runs is its lockfile's to decide.
- **Otherwise, exactly the release asked for.** The action installs
  `@spec-family/<tool>@<version>` with `npm install --ignore-scripts` into a
  directory of its own under the runner's temporary directory. No install
  script runs, nothing is fetched by a name without its scope, and nothing
  else is installed: the tools have no dependencies, and a release that
  brings any package with it is not run. `npm audit signatures` must then
  verify the registry's signature and attestations for it. Behind a
  registry that does not sign, install the tool in the project instead.
- **Two exits of its own.** An input the action cannot act on, or a copy it
  cannot run - a Node older than the tool supports among them - is exit `2`
  and one annotation that says what to do. It never starts a tool it knows
  cannot answer, whose crash would read as findings.
- **No token, no write.** Nothing the action runs reads `GITHUB_TOKEN` or
  writes to the repository; a job running it needs `contents: read`, and
  `security-events: write` only to upload SARIF. The tools call no model,
  need no account and make no network request; the action's one request is
  npm's, when it fetches a tool.
- **Pinned steps.** The action's own step that uses another action,
  `actions/setup-node` for `node-version`, names it by commit.

## Pinning

Two versions are at play. The tool's is an input, `version`, or the
project's lockfile, so a release of a tool needs no release of the action.
The action's own version changes when its inputs or what it runs change.

Name a release of the action by its commit, with the version beside it, as
the family pins every action it runs: the commit is the code that runs,
whatever becomes of a name, and Dependabot's `github-actions` updates keep
such a pin current. Each release here is immutable, so its tag stays on its
commit, and there is no moving major tag. The examples above name `v0.1.0`
by its tag, since this README cannot hold the commit of the release it is
part of. To find the commit:

```bash
git ls-remote https://github.com/spec-family/action "refs/tags/v0.1.0^{}"
```

Release tags are annotated, and the line this prints names the commit the
tag points to. Then:

```yaml
      - uses: spec-family/action@<that commit> # v0.1.0
```

## License

MIT, as `LICENSE` says.
