# Getting started

Choose Docker/Compose for the packaged workflow or native Node for a direct local process. Both use an existing, approved Codex executable and explicit workspace roots. Authenticate and configure that CLI through your approved workflow before using this UI.

## Docker and Compose

### Requirements

- A local Docker daemon you already have permission to use, and the `docker compose` plugin with `up --wait` support.
- Python 3.8 or later and Make on the host.
- The existing approved Codex CLI on the host, selected by its absolute executable path.
- An existing readable workspace and a permitted private local state location.

The host does not need Node or npm for this workflow. The Docker build provides Node and Git for the wrapper. Build dependency downloads occur on the build machine; no CLI, model/provider SDK or browser is downloaded at application startup.

### Configure and start

From the project directory:

```sh
make configure ROOT=/absolute/path/to/workspace CODEX=/absolute/path/to/codex
make up
make open
```

Use `PORT=3780` when configuring if the default host loopback port 3777 is occupied:

```sh
make configure ROOT=/absolute/path/to/workspace CODEX=/absolute/path/to/codex PORT=3780
```

Configuration is local and private under `.local-state`. It contains the selected paths and port, not a copy of Codex credentials. Durable application history is separate, in the checkout's Docker-managed `appdata` volume at `/data/private`. Configure while the service is stopped. For multiple explicit roots, use the same controller directly:

```sh
python3 scripts/manage.py configure \
  --root /absolute/path/to/app \
  --root /absolute/path/to/library \
  --codex /absolute/path/to/codex
```

Each authorized root is mounted at the same absolute path inside the wrapper container. These explicit workspace mounts are writable for guarded worktree operations; the rest of the container filesystem remains read-only. Choose the smallest practical roots. Project and chat selection cannot authorize a new directory outside this startup list.

### Start from a staged image

After building or loading the permitted image through your approved workflow:

```sh
make up NO_BUILD=1
make open
```

`NO_BUILD=1` selects `--no-build --pull never`. If the required image is absent, startup fails rather than downloading it. `make restart NO_BUILD=1` uses the same offline startup behavior. `make build` is the explicit image-build command and can acquire build dependencies.

### Host/container boundary

The container runs the wrapper with no external network interface and exposes no published TCP port. Its HTTP listener uses a private Unix socket. The host bridge listens on `127.0.0.1` and forwards browser bytes through Docker exec stdio to that socket. A separate stdio channel carries native Codex messages.

An explicit chat or capability request causes the host bridge to start the selected host executable with exactly `app-server`. The CLI inherits the host bridge's environment, uses the authorized host working directory and retains its existing enterprise controls. It is not moved into the image and its home, credentials or approved configuration are not mounted or copied into the container. No Docker socket is mounted into the application.

This transport is local to the configured Docker daemon. Remote Docker contexts are refused. Browser and server must belong to the intended local host/session; a browser on another computer or remote-session endpoint does not share the server's localhost automatically.

## Native Node setup

Use Node 24.18.0 and Git for local change/worktree views. The wrapper has no runtime npm dependency or native addon.

```sh
npm ci --ignore-scripts
npm run build
npm start -- --root /absolute/path/to/workspace --codex /absolute/path/to/codex --open
```

Repeat `--root` for additional roots. `--data-dir /private/dedicated/state` selects a private state directory; the default is `~/.t3code-local`. `--port 0` selects a free loopback port. `--open` opens a private local HTML handoff that authenticates the browser; without it, the terminal identifies the private connection file without printing its token.

An extracted release archive already contains the built assets and server. Its native Node mode needs Node 24 and the approved CLI, but no npm install:

```sh
node minimal/server/main.mjs \
  --root /absolute/path/to/workspace \
  --codex /absolute/path/to/codex \
  --open
```

## Release archive

Extract the archive into its intended permanent local directory. It includes the Makefile, Compose configuration, host controller and Dockerfile as well as the built assets and notices.

For the Docker workflow, run the same `make configure`, `make up`, and `make open` commands from that directory. The controller detects the prebuilt archive layout and selects the Dockerfile's `prebuilt` target. No host Node/npm installation is needed; Docker builds or an approved staged image still require the permitted build/import workflow. For a preloaded image, use `make up NO_BUILD=1`.

The Docker volume namespace is derived from the canonical checkout/archive directory. Moving or renaming that directory selects a different namespace; keep the directory stable and follow the [backup guidance](OPERATIONS.md#backup-and-remove) before a move. Native Node state and Docker volume state are separate and are not imported automatically.

## First project and chat

Add a project and select its authorized directories. Create a chat and choose its working directory. Sending a message starts explicit user work; the model picker requests permitted capabilities only when opened. Returning a selector to **CLI default** omits the wrapper override.

Approvals display native context and supported one-time decisions. Unsupported permission/authentication requests fail closed. Secret inputs belong to your approved CLI/authentication workflow. The wrapper never offers full-access or persistent policy-amendment shortcuts.

Independent chats share their files. Create an explicit worktree when one repository needs a separate checkout; other roots remain shared. Code and diff views are local, bounded text views, not a terminal or arbitrary browsing surface.

## Access and persistence

`make open` privately captures the current launch URL through a fixed container helper. Its mode-0600 host cache is `.local-state/run/connection.json`; a private `run/launch.html` hands it to the browser. Only the file URI is passed to the OS opener, keeping the token out of process arguments as well as terminal logs. Logs and health checks do not read or print the capability. The browser removes the token fragment immediately and keeps the token only in its tab session storage. A server restart rotates it; reopen through `make open` if an old tab is unauthenticated. Do not paste launch URLs, tokens or private state into shared logs or issue reports.

`make down` stops the service and preserves configuration and history. For health, logs, backup and troubleshooting, see [Operations](OPERATIONS.md).

## Deployment status

Automated development checks are separate from validation of a particular installation. Confirm the selected CLI version, host/runtime, browser topology, storage/permissions and any required process-specific network enforcement through the [deployment smoke test](DEPLOYMENT-SMOKE.md). Docker availability alone does not establish those facts.
