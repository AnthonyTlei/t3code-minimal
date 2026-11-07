# Verification evidence

Release 0.1.2, verified 7 November 2026 with synthetic fixtures. These results establish bounded local behavior, not compatibility with every installed Codex version, deployment platform or browser policy.

## Automated results

| Check | Completed evidence and scope |
| --- | --- |
| Build and types | Pinned Vite/React/T3 UI graph builds local assets; 16 frontend dependency notices generated. Strict scoped TypeScript check passed. |
| Node tests | **57/57 passed**: fake-CLI subprocesses, HTTP/SSE, local state, filesystem/Git guards, native adapter and private stdio/Unix-socket transport. No real model turn. |
| Python controller tests | **24/24 passed**: explicit private configuration, canonical roots/executables, local daemon pinning, owned lifecycle/locks, bounded input/output, state masking, private connection capture, legacy migration guard offline-start arguments, manifest-verified tar build contexts, unchanged host builder environment and rejection of tampering/private paths/symlinks/oversized input. |
| Native browser E2E | **11/11 passed**, 0 retries. Chrome for Testing 156.0.8078.4; desktop 1440x1000 and narrow 390x844. Real built UI/server/store with deterministic fake subprocesses. |
| Extracted Compose workflow | **12 checks passed** in `output/packaging/compose-smoke.json`, including staged-image `NO_BUILD=1` down/up with history preserved. A compact report is in [packaging-summary.json](verification/packaging-summary.json). |
| Dependency/release boundary | Runtime npm graph is empty. Production dependency audit reported no advisories; that is not a security proof. Archive allowlist, manifest hashes and standalone no-node_modules smoke are exercised separately. |
| Native backend syscall audit | Local post-fix audit: 93 attributed tasks. Backend 36 and fake CLI 21 each made **0 Internet-family connect attempts and 0 send syscalls** in the bounded scenarios. |

The eleven native browser flows include private file handoff authentication without a secret-bearing opener argument, plus explicit multi-root projects/chats and streaming; local code/diffs; manual rename/archive/unarchive and themes; approvals/questions and concurrent chats; cancellation; restart/resume and model defaults; hostile content; recoverable native errors; narrow layout; and worktree creation with authorized shared Git metadata. The update adds delayed-send draft isolation, synthetic IME composition guards, native-resolved approval UI checks, and a delayed-bootstrap/SSE ordering regression. The ordering regression fails when the guard is removed and passes with the fix. Page-request records stay on the local test origin. Traces are disabled to avoid retaining bearer fragments/headers.

The extracted-archive Compose smoke uses the actual Make/controller, prebuilt Docker target, network-isolated container, host stdio bridge and deterministic **host** fake CLI. Its completed checks cover setup/build/start/doctor/status/health; no cold-start or health-triggered CLI; masked private state; real-browser streaming and one-time approval; concurrent sessions/questions/cancel; exact host CLI argv/environment; container Git diffs/worktrees; restart/native resume and idempotent start; actual network-none/read-only/cap-drop/no-port/no-Docker-socket settings and a blocked isolated probe; token-free logs; shutdown preserving state with health becoming unavailable. The running container server/frontend hashes are checked against the extracted manifest, catching stale HTML or server code in a rebuilt image. Prebuilt builds use a bounded, manifest-verified tar context rather than normalized-time filesystem synchronization. The staged-image/offline round also passes. This is a Linux ARM64 container through local Docker Desktop on Darwin ARM64, not a deployment-host verification.

Artifacts: native results at `minimal/output/playwright/results.json`; synthetic screenshots at `output/playwright/local-workspace-light.png`, `local-workspace-mobile.png` and `compose-workspace.png`; extracted workflow results at `output/packaging/compose-smoke.json`. These ignored local artifacts are not real model evidence or shipped private state. Local results are distinct from hosted CI; inspect the GitHub Actions run for the exact tested revision.

Independent reviews found and corrected executable shadowing, stale/restrictive approvals, hidden approval context, session/stale-event races, SSE backpressure and diagnostic mount-option disclosure. Packaging tests retain store ownership guards rather than weakening them for Docker bind mounts: history now uses the named volume's private `/data/private` directory. The controller captures launch metadata privately and preserves legacy history for explicit migration.

## Previous security review and current update

The 29 October review of version 0.1.1 covered all 96 then-current source, documentation and test files with independent baseline/architecture and focused transport review. No wrapper telemetry, remote enrichment, embedded credential or unapproved external service client was found. Generated JS/CSS review found only the local module-preload and authenticated API/SSE fetch paths; there were no remote CSS resource directives. Build/CI downloads and audit-only probes remain explicitly separate from runtime.

The review found one real local disclosure: both browser launchers passed the bearer URL in process arguments. A synthetic Linux cross-UID probe reproduced argument visibility. Version 0.1.1 replaces that with a mode-0600 static HTML handoff under a private directory. Native and Make argv tests, real browser handoff tests, cleanup/rotation checks and independent source review pass. A second cross-UID probe against the shipped helper sees no token fragment in argv and gets `EACCES` reading the private file. [security-summary.json](verification/security-summary.json) records the fix and limits.

The 7 November update received focused independent source reviews of the changed adapter/server and frontend, plus a generated JS/CSS resource-call review. It adds no dependency, provider endpoint, installer, account service, telemetry, background capability request or policy override. The generated bundle still has three fetch sites: the local module-preload helper, authenticated API helper with local callers, and `/api/events`. CSS has no resource URLs/imports. The production npm graph remains empty. These are bounded checks of the update, not a repeat of the earlier whole-repository security scan.

New adapter regressions cover exact native request resolution and request capacity; missing/foreign thread or typed-ID mismatch; early approvals/resolution; completion before acknowledgement; stale turn output; reused or invalid acknowledgements without notifications; fatal replay followed by an approval; and queue/session bounds. Native candidate-key defaults are preserved in the composition guards; browser composition events are synthetic, so real OS/input-method behavior still needs verification.

The original extraction pin is unchanged. [Upstream updates](UPSTREAM-UPDATES.md) records selected behavior ports and explicitly skipped services/features.

## Network observations and limits

[network-summary.json](verification/network-summary.json) preserves fresh source/build hashes, scenario counts and token checks. Raw fresh traces and their hashes are retained in the managed local post-fix audit artifacts from 7 November; they are excluded from the release. Reproduce with `minimal/audit/run.sh`; audit image/tool downloads are build-time research traffic.

This syscall run exercises the native `createApplication` backend in a Debian 12 ARM64 Docker Linux VM with Node 24.18.0, network-none, a non-root UID, dropped capabilities, no-new-privileges and a read-only root filesystem. It covers cold start; **20 seconds idle including SSE heartbeat**; streaming; concurrency; approvals/questions; cancellation; native errors; malformed settings/state; early approval; native request resolution/stale answers; fast completion before acknowledgement; stale turn rejection; removed routes; shutdown; restart/resume and absence of helper methods. It does not kernel-trace the host Python manager, Docker daemon or new packaged stdio topology merely because their source files exist in the checkout.

Separate positive controls captured blocked reserved-address DNS, TCP, redirected HTTP and WebSocket attempts, plus successful loopback DNS, HTTP redirect and WebSocket controls. Send/receive payloads remain opaque in syscall traces; two exact generated session tokens were checked absent from retained artifacts. Browser records omit headers, query and fragments. Attempts and successes are attributed separately from application processes.

**Browser-global kernel observation remains blocked.** Sandboxed Chromium 156.0.8078.47 in the audit container exited before opening a page because user-namespace creation returned `EPERM`. The default security profile was retained; sandboxing was not disabled and privileges were not added. Zero browser network counts before that failure do not validate page/browser-global traffic. Passing native/Compose page-request assertions and the packaged container's network isolation are separate evidence, not a universal browser/CLI/host egress guarantee.

## Real CLI and deployment limits

The automated suites use a deterministic fake CLI. They do not establish a real installation's authentication, protocol, provider policy, MCP behavior or descendant networking. Validate the installed CLI and intended host with the [deployment smoke test](DEPLOYMENT-SMOKE.md).

The packaged topology leaves Codex on the host with its existing environment and controls, while isolating the wrapper container. Actual engine/kernel/architecture, browser topology, filesystem permissions, storage and process-specific network enforcement still require deployment evidence. No real model request, external deployment or host security/network configuration change was performed for these checks.
