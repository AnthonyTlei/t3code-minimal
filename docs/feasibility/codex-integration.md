# Codex integration boundary

The application uses an explicitly selected, already installed Codex executable. Docker mode starts it on the host through the local Python supervisor; native mode starts it directly. Both invoke exactly `app-server`, use an authorized working directory and preserve the existing environment. The wrapper never installs a CLI, copies its credentials, chooses another provider, injects MCP configuration or supplies sandbox/approval overrides.

## Retained protocol

The narrow stdio client initializes the app-server connection, starts or resumes a thread and submits explicit user turns. It handles streamed output, cancellation, native questions and scoped one-time approvals. Model/reasoning choices come from the selected CLI's permitted capabilities, requested only through explicit interaction. There are no automatic title, summary, commit, enrichment or account-polling calls and no arbitrary native RPC proxy.

Unknown authentication, secret-input, persistent-policy and unsupported permission requests fail closed. Existing CLI login, token refresh, provider endpoints, skills, MCP services and descendants remain owned by that installation and its applicable policy. Authentication stays in the normal CLI workflow; the browser wrapper does not collect credentials.

## Version compatibility

A tested fake adapter establishes deterministic wrapper behavior, not compatibility with every CLI release. Before claiming support for a selected version, inspect its available protocol/schema through a permitted offline workflow and perform a bounded real integration check with synthetic data. Confirm streaming, cancellation, questions, supported one-time approvals, concurrent chats and restart/resume. Do not change controls or substitute a CLI to hide an incompatibility.

See [Verification](../VERIFICATION.md) for observed evidence and [Deployment smoke test](../DEPLOYMENT-SMOKE.md) for the consolidated real-installation checks.
