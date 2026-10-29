# Data and security boundary

## Browser and API access

Native mode binds IPv4 `127.0.0.1` only. Docker mode uses a private HTTP Unix socket in the network-isolated container; the host manager listens on `127.0.0.1` and carries raw bytes through local Docker exec stdio. There are no published container ports, host networking or mounted Docker daemon sockets.

All application data APIs and SSE streams require an unpredictable per-run bearer token. Query parameters and cookies cannot authenticate them. Strict Host/Origin checks, rejection of proxy headers/cross-site fetches, and JSON-only mutations remain in both transports. Public built assets contain no private data. The minimal read-only `/healthz` exception needs no token: it returns status/version and bridge readiness, subject to Host/Origin checks, without roots, transcripts or credentials. Container health establishes liveness; host `make health` also requires bridge readiness. Neither probes CLI login or model availability.

CSP blocks external resources/connections, raw embeds, framing and inline scripts/styles. Transcripts create escaped text/local code nodes, not raw HTML, remote images or embedded content. Browser-global update, extension or safe-browsing traffic is a separate policy/observation scope.

Mode-0700 private directories and mode-0600 files protect local capabilities from other OS users. Same-UID processes can generally read that user's files/memory; these controls are not a separate OS security principal or an enterprise sandbox.

## State, logs and deletion

| Mode/location | Contents and ownership |
| --- | --- |
| Native `~/.t3code-local` or explicit `--data-dir` | Private application history/settings and current browser connection metadata. |
| Docker named `appdata` volume, `/data/private` | Application history/settings; created privately by the ordinary numeric service user. The existing store ownership/symlink guards remain enforced. |
| Host `.local-state` | Private configuration and generated Compose configuration; run records/control nonce/socket, operational log and temporary `run/connection.json` capability cache. No Docker transcript bind mount. |

Application state contains projects, chats, transcript/activity, local preferences and non-secret pending requests in `state.json`. `store.lock` enforces one writer; `.state-*.tmp` files support atomic writes. Application `connection.json` rotates on restart and is removed on clean shutdown. A fixed container helper supplies that metadata privately to the host manager; its stdout is captured to the mode-0600 host cache, not terminal logs. Logs and health commands do not read/print the capability. The reserved attachments directory is private, but this version has no attachment upload/copy API; workspace views read original authorized text files.

Version 0.1.1 keeps launch capabilities out of browser-opener process arguments. Native `--open` and Docker `make open` pass only a private `launch.html` file URI to the OS opener. This mode-0600 file under a mode-0700 directory contains a static, strictly loopback-only redirect; it has no script or external resource. The browser navigates internally to the authenticated local page and removes the fragment. Both the private file and connection cache are removed on clean shutdown. Reauthenticate/restart after replacing an earlier version; a token exposed by an earlier launch remains valid until its server stops.

The manager/container keep operational process/listener errors, with bounded container log retention. Tokens, control nonces, request bodies, transcripts and native CLI stderr are not operational log payloads. Native stderr is discarded and native error messages avoid raw credential-like payloads. Transcripts can still contain sensitive user/CLI content and require private backups.

`make down` preserves the named volume and configuration. Docker's project/volume namespace derives from the canonical checkout directory; moving it does not automatically migrate history. Legacy `.local-state/data/state.json` is detected and requires explicit migration, not silent replacement. Follow [Operations](OPERATIONS.md#backup-and-remove) to stop, identify and back up the exact volume and separate private host configuration. Removal is explicit and mode-specific; the wrapper never deletes the CLI's independent credentials/history or CLI-managed records.

## Files and local Git

Startup roots are explicit, canonical and anchored. File/chat cwd checks reject traversal, escaping symlinks, `.git` file views, special files, oversized/binary/malformed text and replaced roots. Final reads use no-follow and inode checks. State paths reject unsafe symlinks and unrelated pre-existing contents.

Docker mounts only those explicit workspace roots at their existing absolute paths, writable for guarded worktree operations. Its root filesystem is read-only; no entire home/credential directory is imported automatically. If an authorized root includes the checkout's private `.local-state`, an inaccessible container tmpfs masks that control subtree. The host CLI still follows its own host filesystem policy; this container mask does not change that policy.

Local Git exposes a guarded status/diff/worktree subset, without fetch/push or remote enrichment. Executables resolve to approved absolute paths rather than project-relative PATH entries. Git hooks, pager, fsmonitor, external helpers, submodule recursion and lazy fetching are suppressed; unsafe local includes, filters/textconv, partial clones, alternate objects and metadata fail closed. Linked-worktree metadata must remain inside authorized startup roots. Git views may differ from normal user Git configuration.

Portable userspace path/inode checks do not provide openat-style whole-path capabilities. A same-UID process racing ancestor/config replacement can still race checks. Separate chats share files, and a worktree isolates only one repository. Use approved OS/filesystem controls for stronger isolation; do not infer it from a root label.

## Host Codex and process ownership

In Docker mode the host Python manager, not the container, starts the selected existing host CLI with exactly `app-server`. It uses the authorized canonical cwd and inherits the existing host environment unchanged. Native mode starts the same selected executable directly. Neither mode installs a CLI, reads/copies credential/config files, changes providers/endpoints/home, injects T3 MCP, adds write roots or supplies sandbox/approval overrides.

The local broker is a bounded transport for owned sessions, not an arbitrary executable/configuration RPC. It rejects invalid frames and unsupported signals; loss of the broker ends its sessions without replaying user work. Local lifecycle control uses private authenticated identity and locks rather than killing processes by name. Remote Docker contexts are refused, and the verified local daemon endpoint is pinned for the running manager without rewriting the CLI's environment.

Only an explicit chat or capability action starts native work. There are no automatic titles, summaries, commits or account/model polls. Native approvals show context and admit only a permitted one-time subset; secret/auth/token-refresh, persistent policy amendments and unsupported requests fail closed. Existing approved CLI skills/MCP/startup behavior and descendants remain governed by existing enterprise controls.

## Egress scope

| Actor | Retained communication |
| --- | --- |
| Browser app | Same-origin local HTTP/SSE and bundled assets; browser-global traffic is separate. |
| Docker wrapper | Private Unix sockets, private volume, authorized workspace/Git access; `network_mode: none`, no capabilities, no-new-privileges and a read-only root filesystem. |
| Host manager | Local loopback browser ingress, verified local Docker Unix socket through Docker exec, and owned CLI stdio. |
| Native wrapper | Loopback HTTP, private files, guarded local Git and approved CLI stdio; it does not inherit Docker network isolation. |
| Approved CLI/children | Explicit user work through existing approved endpoints, sandbox and applicable approvals. Codex approval is not blanket descendant network permission. |

The packaged container's network isolation is distinct from browser/host-manager/Docker-daemon/real-CLI observation. Source review, page-request hooks and bounded synthetic syscall tests do not guarantee universal zero egress. Existing CLI/MCP processes must be measured separately, and required enterprise/browser/descendant enforcement still needs approval and actual-host verification. No host firewall, network or security setting was changed to obtain the reported tests. See [Verification](VERIFICATION.md) for exact evidence and limits.
