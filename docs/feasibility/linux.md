# Runtime compatibility

The packaged workflow keeps the Node wrapper in a Linux container and the selected Codex executable on the host. The native workflow runs the wrapper directly. Neither workflow installs Codex or changes system libraries, authentication, sandboxing or approval policy.

## Requirements by workflow

| Component | Native Node | Docker/Compose |
| --- | --- | --- |
| Host tools | Node 24.18.0, local Git and an existing Codex executable | Python 3.8+, Make, existing local Docker daemon with Compose `up --wait`, and an existing host Codex executable |
| Wrapper runtime | Host Node 24 | Pinned Node 24 Debian-based image with local Git |
| Host Node/npm | Required to build from source and run natively | Not required to run the packaged workflow |
| Workspace access | Explicit canonical roots | Explicit same-path writable workspace binds; remaining container root filesystem is read-only |
| History | Dedicated private `--data-dir` | Private directory in a checkout-specific named Docker volume |
| Browser access | Host IPv4 loopback HTTP/SSE | Host IPv4 loopback gateway carrying bytes through Docker exec to private container Unix sockets |
| Wrapper network enforcement | Separate approved host controls when required | Container `network_mode: none`; host/browser/CLI behavior remains a separate scope |

The host manager uses Unix process/filesystem primitives and targets Linux and macOS. Native Windows deployment is not supported by that controller. Tested platforms and architecture are listed in [Verification](../VERIFICATION.md); do not infer other platforms from a successful build.

## Validate each deployment

A container supplies its userland libraries while sharing the daemon host's kernel. Check the actual CPU architecture, engine/Compose versions, kernel features, permitted image workflow, storage capacity, UID/GID behavior and workspace bind permissions. Docker access alone does not prove compatibility. Do not change daemon groups, socket permissions, host libraries, SELinux, firewalls or sandbox policies to force a pass.

Only local Unix-socket Docker contexts are supported. Remote daemons do not share the host CLI, roots or loopback. The controller rejects remote contexts before daemon operations and pins the verified local endpoint for the running manager.

The browser must reach the same host's loopback listener. A browser on a different computer or remote-session endpoint does not share that localhost automatically. Verify the selected browser/version, private-file handoff and same-origin HTTP/SSE behavior in the intended session.

Use [the read-only inventory helper](../../scripts/feasibility/host-check.sh) for bounded prerequisite facts, review its output before sharing, then run the [deployment smoke test](../DEPLOYMENT-SMOKE.md). It does not establish credentials, model access, quota guarantees or complete network-policy enforcement. Keep any unmet requirement explicit rather than weakening it.
