# Runtime network observation

This audit runs the actual local server and the deterministic fake Codex executable in an isolated local Docker Linux VM. It does not run the real Codex CLI, read credentials, contact third-party systems, or modify host firewall/security settings. It also attempts a sandbox-enabled Chromium run under the existing container security profile. A blocked browser launch is recorded as a verification limitation; the harness never falls back to --no-sandbox or a relaxed profile.

Build the UI first, then run:

```sh
npm run build
bash minimal/audit/run.sh
```

The audit-only image installs `strace` and Chromium during its explicit image build. That build uses external Debian package infrastructure and is not wrapper runtime traffic. The production artifact does not contain this image/tooling. The base image and strace package are pinned; actual package versions and resulting image ID are recorded with the run. Chromium is an audit-only browser resolved from the Debian repository at build time, so rebuilding against a changed repository can produce a different browser/image.

The run uses a non-root identity, a read-only root filesystem, all capabilities dropped, no-new-privileges, and Docker network-none. No ptrace capability, privileged container, host networking or Docker socket mount is used. Only the source/build is mounted read-only; a dedicated evidence directory is writable. All app state and synthetic repositories live in the container's temporary filesystem.

An independent driver launches the backend as a separate process. Kernel process/fork/exec records identify the backend, each fake CLI, browser launch tree, threads and descendants. The audit exercises cold start, a 20 second idle interval including the SSE heartbeat, streaming, concurrent chats, approval/question handling, cancellation, native failure, malformed settings, removed routes, shutdown, restart/resume and malformed persisted state. It records attempted connections as well as successful local networking. Source and built-asset hashes are checked before and after the run to reject evidence from a mid-run edit.

Positive controls run in a separately attributed descendant process and verify that the observer can see failed reserved-address TCP, DNS, redirected HTTP and WebSocket attempts; successful loopback DNS; an HTTP redirect chain; and a WebSocket connection. The reserved addresses are not contacted successfully: network-none returns ENETUNREACH. HTTP and DNS servers for successful controls bind loopback inside the same isolated namespace. Redirect/WebSocket semantics are corroborated with the local server's paths and explicit client outcomes; syscall records alone only prove socket activity.

`output/summary.json` contains token-free counts, endpoints, process attribution, phases and trace hashes. Raw send/receive buffers are deliberately opaque in strace arguments so auth payloads are not retained. Any Internet-family connect or opaque send by backend/fake CLI causes the summarizer to fail; positive controls are kept separate. No external backend or fake-CLI connection observed in these scenarios is bounded runtime evidence, not a guarantee that application code alone prevents every possible egress path.

Network-none is an audit topology. It is not yet the deployment topology: a real browser must reach the backend and the real approved CLI needs its separately permitted connectivity. Production policy, browser-global traffic, the real CLI and children, actual host kernels/engines, longer idle periods and all future changes still require independent enforcement and verification.
