# Releasing `@kuploy/trpc-openapi`

This package is published to **GitHub Packages** (`npm.pkg.github.com`,
`@kuploy` scope) by the `Publish to GitHub Packages` workflow
(`.github/workflows/publish.yml`). CI authenticates with the workflow's
`GITHUB_TOKEN` (requires the repo's Actions **Workflow permissions** to be
set to *Read and write*), so no PAT/`.npmrc` handling is needed.

## How to publish

Bump `version` in `package.json`, then trigger the workflow one of three ways:

1. **Tag push (canonical):** push a `v*` tag, e.g. `git tag v0.0.7 && git push origin v0.0.7`.
2. **Manual:** run the workflow from the Actions tab (`workflow_dispatch`).
3. **Marker commit:** push to `main` with `[publish]` in the head commit
   message. This exists as an escape hatch for environments where tag
   pushes and `workflow_dispatch` are unavailable. Pushes to `main`
   **without** the marker do not publish.

The publish step runs `pnpm publish --no-git-checks`; re-publishing an
already-published version fails (npm/GitHub Packages forbid overwrites), so
always bump `version` first.

## Consuming

Consumers (`kuploy`, `kuploy-cloud`) install from the `@kuploy`-scoped
GitHub Packages registry using a token with `read:packages` in their
`.npmrc` / `NPM_TOKEN`.
