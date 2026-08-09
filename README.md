# DiceKeys TypeScript App for DiceKeys.app and Electron

This branch provides a credential-free, pinned build foundation for auditing and
testing the existing DiceKeys application. It does **not** produce release-ready
wallet software. Desktop outputs are unsigned evaluation artifacts and their
metadata always records `releaseEligible: false`.

## Requirements

- Node.js 22.23.2
- npm 10.9.8 (bundled with that Node.js release)
- Git
- Python 3 for the independent derivation-reference tests
- Normal platform build tools required by Electron

The exact runtime is recorded in `.nvmrc`, `.node-version`, `package.json`, and
the root lockfile. Do not install TypeScript, Vite, or other project tools
globally.

## Bootstrap, verify, and build

From the repository root:

```bash
./scripts/bootstrap
./scripts/check
./scripts/build-release
```

`bootstrap` needs ordinary public internet access on its first run, but it does
not use a GitHub Packages login or a personal access token. It fetches pinned
public source commits, verifies them, builds the four local `@dicekeys`
replacement packages twice, verifies the resulting package identities, acquires
the pinned native inputs, and performs frozen installs in every package root.
The generated sources and package archives remain in the ignored `.cache/`
directory; they are not vendored into Git.

`check` runs the independent Python and TypeScript profile references, all 14
Jest suites and 1,712 tests with no skipped or todo tests, type checks, web
production builds, the canonical Electron build, the Forge check-only build,
and the build-contract security and determinism regressions.

`build-release` repeats bootstrap and verification before creating:

- a deterministic web ZIP;
- a deterministic host-platform desktop tar containing an unsigned package;
- normalized CycloneDX SBOMs;
- provenance, license, package, checksum, symlink, and assertion manifests.

Outputs are written to `release-artifacts/`. The Electron Builder pipeline under
`electron/` is canonical; `electron-forge/` is compiled only as a compatibility
check.

## Offline cache replay

After one successful online bootstrap, the same acquired inputs can be replayed
without network acquisition:

```bash
./scripts/bootstrap --offline
./scripts/check
./scripts/build-release --offline
```

The offline mode is fail-closed with respect to the pinned source, npm, Electron,
and native-input caches. CI provides cross-platform cache replay with fail-fast
proxy sentinels; it does not claim operating-system-level network isolation.
Phase 2 acceptance additionally requires a recorded Linux Docker replay with
`--network none`, which is the authoritative network-denial proof.

## Local development

After bootstrap, start the web application with:

```bash
npm --prefix web run start
```

Start the canonical Electron development application with:

```bash
npm --prefix common run build
npm --prefix web run build-electron-html
npm --prefix electron run build
npm --prefix electron run start
```

The inherited Electron lint baseline currently reports known findings, so it is
available as a non-gating diagnostic:

```bash
npm run lint:diagnostic
```

## Release blockers

Public redistribution remains blocked by unresolved repository/scanner license
terms, a missing helper license file, unreproduced generated-WASM toolchains,
unverified legacy `keytar` native delivery, unsupported Electron 29, permissive
entitlements, and the absence of a fail-closed signed/notarized release path.
See `SECURITY_REVIEW.md`, `DECISIONS.md`, and `RELEASE_CHECKLIST.md` for the
evidence and required remediation.

## Architecture

The app uses a reactive-style of UI coding in which code is divided into:
  - State objects, which represent the current state of the application, and
  - Views, which render mostly-stateless UI components to reflect the application state.

Global state is under the `state` directory and `views` are under the views directory.
State-objects that are local to one or more views may be stored adjacent to their view.

State is managed with MobX, and state classes contain actions (methods) that will modify state.

MobX-enhanced React components automatically re-render views as needed when state changes.
We inject state into these components through their React props (React's name for the parameters passed to a view by its parent).

We borrow from environments like SwiftUI, which allow you to run and inspect individual components by rendering previews, by manually
creating preview HTML files for key components that operate only on the subset of the application state that required for those views.

```bash
npm run preview
```

### Windows USB device handling
Windows requires the app to have admin rights in order to list FIDO usb devices and write to them.

## Security notes

### Dependencies

Due to our strict security requirements, we try to minimize dependencies.  The only non-dev components we use are our own support libraries
  - our own `SeededCrypto` library, built on `LibSodium`
  - our DiceKey scanning library, built on `OpenCV`
  - `emscripten`, the WebAssembly compiler used to build the above two libraries and marshall data
  - `React`, the highly-popular UI library with a great security track record.
  - `MobX`, not quite as popular as React, but a small code base with a great security track record.
  - `vite` generates code during the build process and relies on other dependencies.
  
Testing with `jest` introduces other dependencies, but those should not be compiled into the production applications.


## Build notes

Using `vite` bundler.

## Electron notes

### macOS - Supporting Associated Domains
Associated Domains ([see Apple's developer documentation](https://developer.apple.com/documentation/xcode/supporting-associated-domains)) establish a secure association between the domain(s) associated with the DiceKeys app (dicekeys.app) and this application package.

_To support associated domains, this electron app uses a custom entitlements file ([electron/packaging/entitlements.mac.plist](./electron/packaging/entitlements.mac.plist)) which is not managed by XCode.  That file includes documentation on entitlement settings required by this application to run without crashing._

Useful resources:
- https://github.com/electron-userland/electron-builder/issues/4040
- https://twitter-archive-eraser.medium.com/notarize-electron-apps-7a5f988406db
- https://github.com/electron-userland/electron-builder/issues/3940

### Development mode
#### Refresh HTML contents

You can run _web_ codebase with the following commands. Any change to the html files will trigger an update to the electron html contents without restarting the application itself.
```
cd web
npm run watch-electron-html
```

#### Restart Electron
Restarting electron every time there is a change in the _electron_ codebase can be accomplished by running the following commands in two separates terminal windows.
```
cd electron
npm run watch
```

```
cd electron
npm run start-electron
```
