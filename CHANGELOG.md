# Changelog

## 0.1.2 — 2026-11-07

- Selectively port relevant fixes reviewed through upstream `006d7e38f0485431c314a1afcc39fa823f379092`; retain the original extraction pin and removed-service boundaries.
- Clear native-resolved approvals and questions, reject stale answers, and keep remaining requests and turn status consistent.
- Bind native output and approvals to the acknowledged turn, with bounded early-event buffering and fail-closed handling of invalid or reused turn IDs.
- Preserve newer and other-chat drafts when an asynchronous send completes.
- Keep newer SSE updates when an older bootstrap response arrives, preserving active approval controls.
- Build prebuilt releases from manifest-verified tar contexts and verify running container hashes, avoiding mixed cached HTML/assets after normalized-timestamp rebuilds.
- Respect IME composition in the composer and dialogs; improve dialog-title line height.
- Record the update process and selected/skipped changes in `docs/UPSTREAM-UPDATES.md`.

## 0.1.1 — 2026-10-29

- Keep browser session capabilities out of OS opener process arguments in native and Docker workflows.
- Use a private static HTML handoff with strict loopback validation; remove it on shutdown.
- Add opener-argument, private-file, restart and real-browser handoff regressions.
- Recheck current source, generated assets, release contents and synthetic runtime network behavior.
- Generalize public documentation and normalize release ownership, timestamps and filesystem metadata.

## 0.1.0 — 2026-10-28

- Retain T3's compact interface for local projects, concurrent chats, approvals, history, code and diffs.
- Remove cloud services, telemetry, installers, remote metadata and auxiliary model calls.
- Add an isolated Docker/Compose package with an unchanged host-owned Codex CLI.
- Add Make lifecycle, logs, health, offline startup and private local configuration.
- Keep durable history in a private Docker-managed volume; preserve it on shutdown.
- Include a manifest-verified standalone release, documentation, CI and synthetic verification.

Real CLI integration and deployment platforms require separate validation; see the verification guide.
