# Contributing

Keep changes small and preserve the local-only boundary. Read [AGENTS.md](AGENTS.md), the [development guide](docs/DEVELOPMENT.md) and [maintenance constraints](docs/MAINTENANCE.md) before changing runtime behavior.

## Before submitting

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
PLAYWRIGHT_SKIP_BROWSER_GC=1 npx playwright install chromium
npm run test:e2e
python3 -m unittest discover -s minimal/test -p '*_test.py'
```

Use temporary synthetic workspaces and isolated private state. Add meaningful regression coverage for behavior or boundary changes. Include a concise description of the problem, the resulting behavior, how it was checked and material remaining limits. UI changes should include a sanitized capture when useful.

## Preserve the boundary

- Keep the approved CLI's executable, authentication, endpoints, environment, sandbox and approvals under its existing policy. No installer, provider switch, credential extraction or injected MCP.
- Start model work only for an explicit user request. No automatic titles, summaries, commits, enrichment or background capability/account polling.
- Remove unwanted implementation, routes, jobs and dependency closure rather than relying on hidden controls or default-off settings.
- Retain token authentication, strict Host/Origin checks, JSON-only mutations, CSP, authorized roots and failure behavior.
- Keep release artifacts free of private state, tokens, tests and native CLI credentials. Preserve upstream and dependency notices.
- Distinguish source review, fake tests, browser observations, real CLI evidence and actual-host verification. Do not broaden claims beyond the checks.

Ordinary checks require no real model credentials or paid turns. Never include private user content, credentials, private transcripts or launch capabilities in issues, pull requests, screenshots or test fixtures. Suspected vulnerabilities belong in the [private reporting process](SECURITY.md).
