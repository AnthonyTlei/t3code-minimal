# Development

## Layout

| Path | Responsibility |
| --- | --- |
| `minimal/server` | Zero-dependency Node server, local state/workspace guards, native CLI adapter and local bridge transport. |
| `minimal/web` | Retained/adapted T3 controls, styling and local React composition. |
| `minimal/test` | Focused unit/integration/security tests and deterministic fake CLI. |
| `minimal/e2e` | Browser flows against the real built UI/server with synthetic data. |
| `minimal/audit` | Separate synthetic syscall/network observation tools and positive controls. |
| `scripts` | Local management, build notices and release packaging/smoke checks. |
| `docs` | Usage, operations, security, evidence and pinned-source provenance. |

The original cloud/provider/native monorepo is removed from the working tree. Git retains its pinned revision for provenance; historical source is not shipped or imported. [REMOVALS.md](REMOVALS.md) records that boundary.

## Focused checks

Use Node 24.18.0 and the checked-in lockfile:

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm run test:e2e
```

The tests use temporary synthetic roots and private state. They never seed from live `~/.t3` data or run a paid model turn. The fake executable exercises real subprocess stdio, streaming, native approval/question shapes, cancellation, errors and resume. It is test-only and never a normal startup fallback.

Host controller tests use Python's standard unittest runner:

```sh
python3 -m unittest discover -s minimal/test -p '*_test.py'
```

Run only the relevant focused checks while iterating. Before delivery, verify the complete changed flow and all required boundary regressions. Integrated browser verification belongs to the primary task, avoiding competing UI servers.

## Native development run

After building, use an explicitly selected approved executable and root:

```sh
npm start -- --root /absolute/path/to/workspace --codex /absolute/path/to/codex --open
```

Use a separate `--data-dir` for experiments. Do not run against an existing live T3 installation, real repositories or production transcripts. The app is served from its built assets; it does not require a separate externally reachable dev server.

## Docker workflow

`make configure`, `make build` and `make up` exercise the packaged deployment path. The host manager uses Python stdlib and Docker exec stdio, allowing the approved CLI to retain its host environment. The application image contains the wrapper, built assets and local Git tooling, not Codex, credentials, test adapters or the Docker daemon socket.

Docker history uses the checkout-specific named `appdata` volume at `/data/private`, not a host `.local-state/data` bind mount. Host `.local-state` holds configuration and controller records; connection metadata is captured privately only for browser access. Keep store ownership/symlink guards intact. Test packaging through an ordinary non-root UID and verify that down/up preserves the named volume. Legacy bind-mounted history requires explicit migration rather than automatic replacement.

`make up NO_BUILD=1` and `make restart NO_BUILD=1` run from the staged image with no build or pull. Use them when checking an offline artifact; image absence must remain a visible failure. The Make `package` target builds, creates and smoke-checks the native/prebuilt archive and therefore still requires the development Node toolchain.

Use the local fake adapter only in isolated packaging tests. Record that distinction in evidence; it does not validate an independently selected CLI release or deployment host. Image builds and dependency acquisition are build-time actions, distinct from runtime network behavior.

After creating the release archive, `npm run test:compose` exercises its Make lifecycle, real browser, host fake CLI, restart/resume, offline startup and container isolation. It needs the local Docker daemon and test browser, and removes only its own temporary synthetic project and volume.

## Release archive

```sh
npm run package
npm run verify:release
```

The packager uses an explicit file allowlist. `MANIFEST.json` hashes shipped files, and the archive has a SHA-256 sidecar. The standalone smoke check extracts outside the checkout, verifies the manifest and exercises the release without `node_modules`. Build notices preserve licenses for the bundled frontend dependency closure. The archive also includes Make/Compose, the host controller and Dockerfile; when frontend source is absent and built assets are present, the controller selects the Dockerfile's `prebuilt` target automatically. Its Docker workflow needs Python, Docker/Compose, Make and the approved host CLI, but no host Node/npm installation.

Never package private state, launch capabilities, `.env` files, credentials, test fixtures, audit probes, node_modules or historical `.git` contents. See [Maintenance](MAINTENANCE.md) before updating dependencies or upstream components.

Release headers use numeric owner/group zero, generic owner labels, normalized timestamps and USTAR without extended filesystem metadata. `SOURCE_DATE_EPOCH` can set the public release timestamp; the default is zero. The release smoke check rejects account names, unnormalized metadata and unexpected archive entries. GNU tar and bsdtar are supported packaging tools.

## Network evidence

Run the separate audit harness only with synthetic data and its documented scope. It attributes backend, test CLI and descendants, and tests the observer with successful and failed local/reserved-address controls. Browser page-request assertions do not measure every browser-global DNS/socket attempt. Keep real CLI, host/browser policy and target-platform evidence separate; [VERIFICATION.md](VERIFICATION.md) records current limits.

The GitHub workflow runs the focused fake-adapter checks. It does not need Codex credentials, contact model endpoints, publish packages or deploy the app. Preparing a workflow file is not evidence that its hosted run has passed.
