# Building Agent Workspace

## Local verification before review

Run `pnpm verify` from a clean, committed checkout on macOS to execute the full
desktop verification pipeline in a disposable worktree. Use
`pnpm verify --pr <number> --publish` to verify a PR head and attach its result to
that commit on GitHub. See [local verification](docs/local-verification.md) for
requirements, evidence locations and failure handling.

## Local Windows trial build

On Windows with Node.js 22.19+ and pnpm 10.17.1, install dependencies and build
an unpacked application directory with:

```powershell
pnpm install --frozen-lockfile
pnpm run pack
```

The app is written to `apps/desktop/dist/win-unpacked`. Provider CLIs installed
as native `.exe` files or package-manager `.cmd` shims are both supported. If a
CLI is not on `Path`, select its executable or shim in the app's provider
settings.

## Local macOS trial build

For a fast, unpacked Apple Silicon build intended for local use:

```bash
pnpm --dir apps/desktop run pack:local:mac
```

The app is written to:

```text
apps/desktop/dist/mac-arm64/Agent Workspace.app
```

This command runs the existing desktop typecheck and production bundle, then
packages the app with `electron-builder --dir --mac --arm64`. It disables
certificate auto-discovery with `CSC_IDENTITY_AUTO_DISCOVERY=false`, so the
result is unsigned and is suitable only for local testing. On a warm local
checkout, expect roughly 20–30 seconds.

Use this path when you need a fresh app bundle for local iteration and do not
need a distributable installer or Gatekeeper validation.

## Distribution build

For release artifacts, use the standard repository command:

```bash
pnpm dist
```

The distribution path enables the normal Electron Builder release workflow.
It discovers an available signing identity, performs macOS code signing, and
builds DMG and ZIP artifacts. In a release environment configured with Apple
notarization credentials, the release pipeline also performs notarization.
Signing Electron's nested files and producing distribution archives is much
slower than the local trial build.

Use the distribution path only when producing artifacts for other machines or
validating the complete signing, notarization, and installer workflow.
