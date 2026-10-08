# Contributing to Teamlet

Thanks for your interest in improving Teamlet! Bug reports, ideas, documentation fixes, and code are all welcome. By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs and ideas**: open an [issue](https://github.com/gs-rumana/teamlet/issues/new/choose). For anything bigger than a small fix, please open an issue before writing code, so we can agree on the approach first.
- **Security problems**: don't open an issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js ≥ 22.18 (the version in `.nvmrc` is what CI and the releases use) and pnpm (`corepack enable` installs the version pinned in `package.json`). To try agents end to end, you also need at least one of the `claude` and `codex` CLIs, signed in.

```bash
pnpm install
pnpm dev          # API on :4317, UI with hot reload on http://localhost:5173
pnpm desktop      # the macOS desktop app
```

To keep test sessions out of your real history, give the server its own data folder: `TEAMLET_DATA_DIR=/tmp/teamlet-dev pnpm dev:server`. If you work from inside an AI coding tool, its environment variables (such as `CLAUDE_CONFIG_DIR`) reach the server. Start it with `env -i HOME="$HOME" PATH="$PATH" …` to see what a normal terminal would.

## Making a change

[CLAUDE.md](CLAUDE.md) explains the architecture and the conventions the code follows; read it before a larger change. In short:

- The server runs TypeScript directly through Node's type stripping, with no build step. Use `.ts` extensions in relative imports and `import type` for types, and stick to erasable syntax (no `enum`, `namespace`, or constructor parameter properties).
- `shared/protocol.ts` is the contract between server and UI. Changes to state the UI shows start there.
- There's no linter or formatter. Match the style of the code around your change: 2 spaces, double quotes, semicolons, and comments that explain *why*.
- The UI is monochrome on purpose. Use the CSS tokens in `web/src/styles.css`, not new colors.

Then check your change:

```bash
pnpm check        # typecheck, build the UI, run the tests
```

The tests in `test/` start the real server and check its security boundary: origin checks, DNS rebinding, sign-in, and the MCP endpoint. If you touch `server/index.ts`, `server/auth.ts`, or `server/mcp.ts`, add a test for the new behavior.

## Pull requests

- Keep each pull request to one change, and explain what it does and why.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything users would notice.
- For UI changes, include before and after screenshots (light and dark if colors change).
- CI must pass. It typechecks, builds, and tests on Node 22 and 24, packages the macOS app, and builds the Docker image.

## Releasing

Maintainers publish a release by pushing a version tag:

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, add a new empty `## [Unreleased]` above it, and update the links at the bottom.
2. Set `"version"` in `package.json` to `x.y.z`.
3. Commit and tag:

   ```bash
   git commit -am "Release vx.y.z"
   git tag -a vx.y.z -m "vx.y.z"
   git push origin main vx.y.z
   ```

The [release workflow](.github/workflows/release.yml) first checks that the tag matches `package.json` and that `CHANGELOG.md` has a section for the version. It then builds the macOS apps (Apple silicon and Intel) and a multi-platform Docker image (pushed to `ghcr.io/gs-rumana/teamlet`), and creates a GitHub release with that changelog section as its notes. A version with a suffix, like `0.3.0-beta.1`, becomes a prerelease and doesn't move the `latest` image tag.

The macOS app is signed and notarized when the repository has these secrets: `MAC_CERTIFICATE` (a base64-encoded Developer ID Application `.p12`), `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Without them it's signed ad hoc, and the release notes explain how to open it.
