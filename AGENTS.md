# T3 Code Local

This is the reduced local-only fork, pinned from upstream in docs/feasibility/UPSTREAM.json. Product boundaries are documented in README.md and docs/SECURITY.md. Keep deployment and real CLI compatibility claims limited to recorded evidence.

## Boundaries

- Retain T3 UI provenance and MIT notices. Do not reintroduce cloud/provider/telemetry/update/auxiliary-model implementations.
- Use only an explicitly selected existing Codex executable. Never install a CLI, change its environment/auth/config/provider/endpoints, inject MCP, or set sandbox/approval overrides.
- Start native work only after explicit user action. No automatic titles, summaries, commits, enrichment or account/model polling.
- The wrapper is loopback-only and token-authenticated. Preserve strict Host/origin checks, JSON-only mutations, restrictive CSP and authorized-root checks. Fail closed on invalid configuration.
- Never read or seed from live ~/.t3 data or private user content. Tests use isolated synthetic roots/private state and a fake subprocess adapter. Never log tokens, native stderr or credentials.
- Do not alter host network/security settings, use privileged containers, deploy, publish, or spend money without explicit authorization.
- Separate observed browser/backend/CLI/child traffic; application code is not an OS sandbox or a universal zero-egress guarantee.
- Do not kill processes by pattern. Stop only owned handles/captured PIDs. Preserve unrelated workspace changes.

## Structure and checks

minimal/server contains a zero-dependency Node 24 HTTP server, strict private store, guarded local workspace/Git access and a narrow Codex stdio adapter. minimal/web retains and adapts T3 primitives and visual styling. Browser communication uses authenticated fetch/SSE; there is no WebSocket server, remote connection layer or general native RPC proxy.

Run npm ci --ignore-scripts, npm run build, npm test and npm run test:e2e. These are the focused fork checks, not upstream monorepo checks. New behavior needs meaningful focused tests. Parallel source reviews are permitted. The primary agent owns integrated browser verification; subagents must not start competing UI servers.

Use only the pinned lockfile. Production artifacts contain built assets/server code and no npm dependencies or test adapters. Verify release contents, source absence scans, licenses and runtime behavior after changes. Record limits honestly; fake tests do not establish real CLI or deployment behavior.
