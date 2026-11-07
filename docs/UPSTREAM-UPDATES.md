# Upstream updates

This repository is a maintained extraction of T3 Code. The original implementation and dependency graph were removed, rather than retained behind configuration switches. This makes the runtime small and auditable, but upstream merges are not automatic: a broad merge or cherry-pick can restore removed files, scripts and services.

Updating this fork means selecting local improvements, adapting them to the narrow implementation, and repeating its boundary checks. Runtime startup never checks GitHub or polls for updates.

## Review of 7 November 2026

Original extraction: `975b3dc56850d8a22dc90462219e53be95d8dcf7`.

Reviewed snapshot: `006d7e38f0485431c314a1afcc39fa823f379092`, 1,568 upstream commits ahead. This is a targeted relevance review of retained primitives and Codex lifecycle behavior, not a full security audit of those upstream commits or a claim that their features are present here.

| Upstream change | Result in 0.1.2 |
| --- | --- |
| [Native request resolution, #23234](https://github.com/pingdotgg/t3code/commit/13c7de296c3e761b824dda3a6819421bf77ca06b) | Handle `serverRequest/resolved` only for the owned thread and exact typed request ID. Remove the stale question/approval, reject later answers, release request capacity and recompute the remaining request status. No approval is issued by the notification. |
| [Reject an earlier run's turn, #25224](https://github.com/pingdotgg/t3code/commit/54d0a161bb20db5d2ccb50f7dad2b4d1bbf05e97) | Adapt the ownership rule to the local adapter. Buffer early turn events/requests until acknowledgement, with a 1,024-frame/4 MiB limit; require exact thread/turn scope; reject reused/invalid turn acknowledgements. A session has a 10,000-turn limit checked before new work. Fatal replay closes only the owned process and cannot expose a subsequent approval. |
| [Keep a newer draft, #24684](https://github.com/pingdotgg/t3code/commit/3f695422ae21be7ce8537eb86c3abb63bfd94e03) | Keep one draft per local chat and clear only the unchanged submitted draft after an asynchronous send. Switching chats or typing a newer draft no longer loses input. No persistence or remote draft store added. |
| [Composition #24016](https://github.com/pingdotgg/t3code/commit/645df4541bd4e0ba9e93b471aa0582b71115a6c6), [#28298](https://github.com/pingdotgg/t3code/commit/91f66f88de342b0485e7f5a20296b4073725b984), [#23231](https://github.com/pingdotgg/t3code/commit/d3315d26e9165e20c89b0943811da25b5f846f2f) | Guard composition and legacy key code 229. Preserve native candidate-key defaults; avoid sending, submitting forms or closing a composing dialog. Browser tests use synthetic composition events; real OS/input-method combinations still need device verification. |
| [Readable dialog titles, #30527](https://github.com/pingdotgg/t3code/commit/a185dd924889cd7f925760431a9f29b973a35e2f) | Retain the line-height correction in the local native-dialog implementation. |

The retained wordmark, input, badge, separator, label and keyboard primitives have no upstream source changes in this range. New button variants are unused here and were skipped. The upstream textarea row-height change injects inline styles; it was not imported because the local CSP forbids them and no current caller supplies rows. The text-direction shared-package reexport was skipped: the fork has no such monorepo dependency. Other lifecycle changes for partial-answer classification, interrupt orchestration and Effect write handling do not map to this adapter's implementation.

Hosted integration testing also exposed a local snapshot race: a slower bootstrap response could overwrite a newer SSE approval update. The frontend now keeps the newer streamed state. A deterministic browser regression delays the real older response until the approval appears; it fails with the ordering guard removed and passes with the fix. This is a local integration correction, not an imported upstream service.

Extracted-release verification exposed a separate build-context cache issue: equal-sized HTML with normalized timestamps remained stale while a newly named JavaScript asset was copied. Prebuilt builds now send a bounded, manifest-verified tar context, with descriptor-based path checks and generic archive metadata. Unmanifested files are excluded. The smoke test compares the running container's server/frontend hashes with the release manifest before opening its browser. Docker build subprocesses select the daemon's local default BuildKit builder; configured remote builder variables do not select a build destination. Host settings and the inherited Codex environment are unchanged. [Docker's default-builder behavior](https://docs.docker.com/build/builders/#default-builder) documents its daemon/context binding.

Remote environments/relays, providers and accounts, credential services, dictation/transcription, hosted Git/PR media, previews, remote images, usage services, installers/updaters, scheduled/background actions, enrichment and auxiliary AI remain excluded. No dependency version was changed in this update; the lockfile changes only the application version.

See [verification evidence](VERIFICATION.md) for the checks actually run against the ported source. Synthetic tests do not validate a real Codex release, its enterprise authentication, MCP/children, browser-global networking or a target host.

## Repeat the review

These are explicit development operations. Fetching upstream contacts GitHub; none of these commands runs during application startup. Never execute files or installers from the fetched upstream tree.

In a fresh clone, add the upstream remote once:

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
```

Then fetch without changing the working tree:

```sh
git fetch --no-tags --no-recurse-submodules upstream main
git rev-parse upstream/main
git log --oneline 006d7e38f0485431c314a1afcc39fa823f379092..upstream/main -- apps/web/src packages/effect-codex-app-server apps/server/src/orchestration-v2
git diff --no-ext-diff --no-textconv 006d7e38f0485431c314a1afcc39fa823f379092..upstream/main -- apps/web/src/components/ui apps/web/src/textDirection.ts
```

Use the last reviewed revision from `docs/feasibility/UPSTREAM.json` when it advances. Fetch that revision too if working with a shallow clone. Resolve and retain the exact new SHA before reviewing so a moving upstream branch cannot silently change scope.

Use the copied-path map in `minimal/web/UPSTREAM.md` and the removed-component inventory in `docs/REMOVALS.md`. Inspect applicable source changes, port only selected behavior into `minimal/`, and add meaningful regressions. Keep the original extraction revision unchanged; update `lastReview` and this record to distinguish review from adoption. Do not run `git pull upstream main` or merge the upstream monorepo into this fork.

Run the checks in [Maintenance](MAINTENANCE.md): pinned install, build/types, Node and Python suites, browser flows, standalone release, Compose lifecycle and the attributed network audit. Review generated assets and all changed network/process entry points. Keep the existing CLI argv, inherited environment, authentication/configuration ownership and one-time approval restrictions intact. Record blocked checks and source hashes instead of reusing an older pass for changed code.
