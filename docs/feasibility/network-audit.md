# Network and data-flow boundary

The browser UI uses authenticated same-origin HTTP/SSE and bundled static assets. Transcript, filename, approval and diff content render as escaped text/code rather than active HTML, remote images, links or embedded media. The server applies restrictive CSP and Host/Origin checks.

The backend has no external service client, telemetry exporter, account service, updater, runtime installer, remote metadata lookup, URL preview or auxiliary model service. Guarded local Git operations suppress network-capable helpers and lazy fetching. Native mode has no OS egress sandbox by itself; Docker mode places the wrapper in a network-none container and carries local traffic through private Unix sockets and Docker exec.

The selected host Codex is the explicit work boundary. Its existing provider, MCP and descendant behavior follows its independent configuration and controls; keeping that environment unchanged does not prove its destinations. Browser-global traffic, desktop services, Docker daemon behavior and host policy are separate observation/enforcement scopes.

Build and CI workflows intentionally acquire pinned dependencies, images and test tools. Audit-only probes intentionally attempt reserved-address DNS/TCP/HTTP/WebSocket connections to verify the observer and isolation. These are not shipped application runtime services. The release allowlist excludes test adapters, audit probes, dependency trees, credentials and private state.

Review [the removal inventory](../REMOVALS.md), [data/security boundary](../SECURITY.md), [verification evidence](../VERIFICATION.md) and [runtime audit tooling](../../minimal/audit/README.md). Source searches and page-request hooks alone do not prove universal zero egress. Retain process attribution, positive controls and bounded-scenario limits in every runtime result.
