# Documentation

## Use the application

- [Getting started](GETTING-STARTED.md): Docker/Compose setup, native Node setup, roots and private browser access.
- [Operations](OPERATIONS.md): start, stop, logs, health, state, backup and troubleshooting.
- [Deployment smoke test](DEPLOYMENT-SMOKE.md): a bounded check for a selected host, CLI and browser session.

## Develop and maintain

- [Development](DEVELOPMENT.md): repository structure, focused checks, synthetic test adapters and release packaging.
- [Contributing](../CONTRIBUTING.md): small changes and verification expectations.
- [Maintenance](MAINTENANCE.md): reviewing upstream updates without reintroducing removed services.
- [Removed implementation inventory](REMOVALS.md): what was removed and what replaces it.

## Security and evidence

- [Data and security boundary](SECURITY.md): authentication, roots, local data, Codex ownership and egress limits.
- [Security reporting](../SECURITY.md): handling a suspected vulnerability privately.
- [Verification evidence](VERIFICATION.md): observed results, tested scope and remaining limits.
- [Network summary](verification/network-summary.json): bounded runtime observations and tested hashes.
- [Packaging summary](verification/packaging-summary.json): extracted-release lifecycle, browser, host CLI transport and container checks.
- [Final security summary](verification/security-summary.json): source/asset review, corrected browser-launch disclosure and remaining external verification limits.
- [Runtime audit tooling](../minimal/audit/README.md): reproducing the synthetic process/network audit.

## Provenance and deployment notes

- [Retained T3 UI source](../minimal/web/UPSTREAM.md) and [upstream pin](feasibility/UPSTREAM.json).
- [Runtime compatibility](feasibility/linux.md) for native and Docker workflows.
- [Deployment and integration notes](feasibility/README.md): public implementation constraints and integration boundaries.
- [Original license](../LICENSE).
