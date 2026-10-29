# Deployment and integration notes

This directory records public implementation constraints and the pinned upstream source. It is not a deployment certification or a record of any particular installation.

- [Upstream provenance](UPSTREAM.json): source revision and retained license notice.
- [Runtime compatibility](linux.md): native and Docker prerequisites, platform limits and validation checklist.
- [Codex integration](codex-integration.md): the narrow stdio interface and ownership of authentication and policy.
- [Network boundary](network-audit.md): retained local communication, removed services and observation limits.

Start with [Getting started](../GETTING-STARTED.md). Before relying on a new host or CLI version, run the [deployment smoke test](../DEPLOYMENT-SMOKE.md) with synthetic data and separate private state. [Verification](../VERIFICATION.md) records the tested scope and remaining limits.
