# Removed implementation inventory

Baseline: pingdotgg/t3code 975b3dc56850d8a22dc90462219e53be95d8dcf7. The working tree physically removes the upstream apps, packages, infrastructure, installers, release tooling, native helpers, provider registries, vendored references, automatic integrations/agent skills, broad lockfile and unrelated assets. Git retains the original revision for provenance; none of that historical source is packaged or imported by the reduced app.

| Implementation removed | Original examples | Replacement/retained boundary |
| --- | --- | --- |
| Analytics and remote observability | apps/server/src/telemetry, observability, browser OTLP proxy/probes | No exporters, event queue, upload/retry/finalizer or telemetry routes/deps; bounded local errors only. |
| Update checks, downloads, managed CLI/auth | cli/update, cloud/selfUpdate, provider/CodexInstallation, CodexManagedRuntime | Existing selected executable only; no install/update/auth/provider routes. |
| Metadata/pricing/theme/version fetches | ModelManifest, usage/UsageService, web state/npmRelease, openVsxThemes | Manual local settings and on-demand approved CLI model catalog. |
| Auxiliary AI and enrichment | textGeneration, ThreadTitleRegenerationService, ThreadTitleLinks and orchestration triggers | Manual titles and deterministic New chat; no title/summary/commit/PR/background model service. |
| Hosted login/cloud/mobile/remote/relay | cloud services, publicConfig, shared/relayClient, desktop/mobile/marketing/infra | Local capability authentication and same-machine browser only. |
| Extra providers and registries | Claude/Cursor/Grok/OpenCode/ACP/Muse providers, provider-acp-registry and SDK dependencies | Narrow stdio Codex adapter with no injected MCP, auth overlay or environment/config override. |
| Remote source-control integrations | source-control Azure/Bitbucket/Forgejo/GitCafe/GitHub/GitLab providers | Guarded local status/diff/worktree operations only. |
| URL/media/browser previews and remote resources | ChatMarkdown media paths, preview/browser integration, untrusted HTML routes, favicon capture pipeline | Text/code formatting, local diffs, no raw HTML/images/embedded content, strict CSP. |
| Broad root reads and policy UI | WorkspaceFileSystem absolute/home reads, full-access defaults, session autoapproval/policy amendments | Explicit canonical roots; one-time native decisions; no app sandbox/approval override. |
| Unneeded runtime/native graph | Effect monorepo, keyring, node-pty, fff, Playwright browser provisioning, hosted auth/Stripe/other-provider SDK branches | Zero runtime npm dependencies/native addons. React/UI tooling is build-time; actual retained bundle licenses generated locally. |

The frontend extraction retains the actual T3 wordmark, compact UI primitives, palette and layout, with native dialogs for the strict CSP. It replaces composition tied to removed orchestration. See minimal/web/UPSTREAM.md for exact copied/adapted files and limits. Full editor/highlighting/terminal/media capabilities are intentionally absent; this is not upstream feature parity.

No hidden setting can reactivate removed services. Unknown settings/routes/native operations fail closed. The release is assembled from an allowlist and excludes tests, fake adapter, audit probes, node_modules, .git, environment files and private state. Test/audit code intentionally contains synthetic network probes; it is not runtime application code.
