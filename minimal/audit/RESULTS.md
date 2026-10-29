# Observed local runtime result

Verified 29 October 2026 with synthetic data and the current application source. Compact counts, scenario scope and tested source/build hashes are in [network-summary.json](../../docs/verification/network-summary.json). Raw audit traces are not shipped; reproduce them with the audit runner.

Mode: **native backend → fake CLI**. This run hashes all current server modules, including optional bridge/health modules, but does not exercise the Python host manager, HostBridge/UDS transport or actual Compose topology. The archive/Compose inspection and browser checks are separate evidence. Hash coverage is not execution coverage.

The backend/fake-CLI audit **passed** in the bounded synthetic exercise. It used the actual server modules and built UI assets, an independently forked driver, and the deterministic fake CLI. Across 93 traced tasks, the backend accounted for 36 tasks and the fake CLI for 21. Neither actor made an Internet-family `connect` attempt or a `sendto`/`sendmsg`/`sendmmsg` syscall. The backend bound only 127.0.0.1. Those send-call counts do not mean no HTTP response bytes were written: allowed accepted loopback sockets use ordinary write operations, whose payloads were intentionally not captured.

Observed scenarios: cold start; 20 seconds idle with the SSE heartbeat observed; normal streaming; concurrent chats; command approval; question; cancellation; native failure; malformed settings; removed route; shutdown; restart/resume; native helper-method absence; malformed persisted state. Source/build hashes remained unchanged across the run.

Four separately attributed negative controls were captured at syscall level and failed with ENETUNREACH: DNS to 198.51.100.53:53, TCP to 198.51.100.42:443, redirected HTTP to 198.51.100.43:8080, and WebSocket to 198.51.100.44:8080. Successful controls included local DNS returning 127.0.0.1, a local `/redirect` → `/final` chain, and a local WebSocket upgrade. The application-semantic outcomes are corroborated by the controlled client/server, rather than inferred solely from socket syscalls.

The browser-global verification **did not pass**: sandbox-enabled Chromium 156 was attempted and its launch tree was traced, but it exited before creating a page. `trace.55:45` records `clone(... CLONE_NEWUSER|SIGCHLD) = -1 EPERM`; Chromium reported “No usable sandbox.” No --no-sandbox flag, security-profile relaxation, host-network mode, privilege escalation or added capability was used. Its absence of connection attempts during failed launch is not evidence about browser-global behavior when a page is running. The local Playwright page tests are separate evidence.

The audit image was `sha256:6c3ca06f21475abc99fb786a8b84990757a1d7461fa9706b3dd09e185ea9e4ef`, Linux ARM64, based on pinned Node 24.18.0 Debian 12. Tools: `strace=6.1-0.1`, `chromium=156.0.8078.47-1~deb12u1`. It ran as a non-root identity with all capabilities dropped, no-new-privileges, read-only root filesystem and network-none. Build-time package downloads are distinct from app-runtime traffic.

Raw send/receive arguments were opaque pointers to avoid recording authentication payloads. Both generated session capabilities were checked for exact absence from retained artifacts; the report stores only the pass result and count. General auth/launch-URL markers are also rejected by the summarizer.

This is local Docker Linux VM evidence, not a deployment-host or real CLI verification, a production network topology, long-term idle certification, browser-global verification, or proof that application code alone guarantees zero egress. The real CLI, descendants, browser policy and final host enforcement remain separate validation work.
