# Maintaining the restricted fork

Keep the pinned baseline and retained-code provenance/required notices. This fork is a small extraction, not a feature-flag profile of the upstream monorepo. Review upstream changes selectively; do not merge the original provider/cloud/bootstrap/runtime wholesale.

1. Re-pin reviewed source and exact build dependencies. Regenerate the lockfile deliberately, review the dependency closure and bundled notices, and retain zero runtime npm dependencies unless a concrete reviewed need justifies otherwise.
2. Reject new external clients, accounts, telemetry/exporters, remote assets/themes/fonts, registry/update/install paths, relays, arbitrary RPC proxies and auxiliary model calls. Trace cold start, idle, errors and fallbacks; a disabled setting or unused UI is not removal.
3. Keep Codex launch arguments/environment/config and enterprise policy ownership unchanged. Validate the exact approved protocol schema and only expose permitted capabilities. Unknown/native permission/auth requests must fail closed; do not add full-access or session policy amendment shortcuts.
4. Rerun the focused unit/integration tests and browser E2E, including hostile content, Origin/Host/CSRF, path/symlink/root replacement, persistence failures, overlap/cancel/restart and stale approvals. Preserve the executable-shadowing regression.
5. Rebuild the release, inspect MANIFEST and notices, and run it without node_modules. Confirm no tests, fake CLI, audit probes, state, tokens or historical source enter the artifact.
6. Repeat runtime attempted/successful network observation with a positive control, separating browser/backend/CLI/children and build-tool traffic. Never infer zero egress from URL searches or page-request hooks alone. Preserve deployment enforcement; no automatic firewall/sandbox/browser-policy changes.
7. Refresh the supported-platform matrix and actual CLI integration evidence before claiming deployment readiness. Record unverified items explicitly and consolidate remaining real-environment checks into one smoke test.
