# Deployment smoke test

Use this bounded check before relying on a new host, CLI version or browser session. Review local prerequisites with [the read-only host inventory](../scripts/feasibility/host-check.sh). Use a synthetic repository and separate private application state. Do not relax host security, change CLI policy or use sensitive project data to make a test pass.

1. Start the packaged or native workflow with the selected existing CLI. Confirm that only the intended local browser can authenticate, the private-file handoff works and the CLI retains its existing authentication, sandbox and approval behavior. Record runtime/engine, kernel, CPU architecture, browser and artifact versions or hashes.
2. Send one harmless explicit synthetic request. Check real streaming, a non-secret question or one-time approval if requested, a second concurrent chat, cancellation, restart/resume, manual rename/archive and local code/diff views.
3. Where network restrictions are required, observe attempted and successful DNS/connections/redirects/WebSockets separately for browser, wrapper, CLI and descendants using permitted tooling. Verify the observer with a controlled local positive test. Check idle and error paths, and confirm each actor stays within its intended policy.

Record one concise pass/fail result with sanitized evidence and exact blockers. Do not include tokens, credential-bearing endpoints, private configuration, real repository files or transcripts. A screenshot, mock test or development-machine run does not establish another host's behavior. If a prerequisite is missing, stop the dependent deployment rather than broadening access or disabling safeguards.
