# Contributing

## Working on the action

The action is `action.yml` and the plain JavaScript in `src/`, with no build
step and no dependencies. `npm test` runs the tests on Node 22 or later:

- `test/action.test.mjs` runs the script against a stand-in for a tool.
- `test/metadata.test.mjs` holds `action.yml`, the workflows, the README and
  this changelog to each other: every action pinned by commit with its
  version beside it, the README's inputs and outputs as `action.yml` has
  them, and the README and the changelog at the version `package.json` names.

The self-test workflow runs those, then the action itself against the
fixtures in `test/fixtures`, fetching each tool from npm and from a
project's own install, and checks each step's exit code, outputs and SARIF
(`test/check-run.mjs`).

## Versions

A release is a tag `vX.Y.Z`, never moved once pushed, and there is no
moving major tag such as `v1`: a workflow names a release by its commit,
with the version beside it, and Dependabot proposes the next one.

- A change that breaks a workflow pinned to the last release - an input or
  an output removed or renamed, or a meaning changed - raises the minor
  version while the action is 0.x, and the major version from 1.0.
- A new input or output, or another tool the action can run, raises the
  minor version.
- Anything else raises the patch.

A release of a tool needs no release of the action: the tool's version is
an input, `version`, or the project's lockfile.

## Releasing

Three steps, by three hands.

1. **The release pull request**, from a branch off `main`, which sets the
   version everywhere the repository names it:
   - `version` in `package.json`;
   - every `spec-family/action@vX.Y.Z` in the README, the `refs/tags/vX.Y.Z^{}`
     in its Pinning section, and that section's example, which names the
     release's commit as `<that commit>`;
   - the changelog's first section, `## X.Y.Z - YYYY-MM-DD`, dated the day
     of the release.

   `npm test` fails while any of these names another version. Merge it once
   the self-test is green.
2. **The tag**, by the maintainer: an annotated tag `vX.Y.Z` on the merge
   commit on `main`, pushed to `origin`. Nothing else is tagged.
3. **The GitHub release**, by Norman, in the web UI, since the Marketplace
   box is only there: *Releases*, *Draft a new release*, choose the tag
   `vX.Y.Z`, title `vX.Y.Z`, the changelog's section as the notes, tick
   *Publish this Action to the GitHub Marketplace* with a primary category,
   and *Publish release*. The first listing also asks for the Marketplace
   Developer Agreement and two-factor authentication on the account.

   Immutable releases are on for the repository, so the published release's
   tag cannot be moved or deleted. The setting covers releases published
   after it was turned on.

Afterwards, a pull request of its own may put the commit the tag names in
place of `<that commit>` in the README's Pinning example, so that it can be
copied as it stands; the metadata test takes either for the version in
`package.json`. The next release pull request puts `<that commit>` back.
