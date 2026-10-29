# Operations

Run commands from the project directory. The packaged Docker workflow uses the private configuration written by `make configure`.

## Lifecycle

| Command | Behavior |
| --- | --- |
| `make configure ROOT=... CODEX=... [PORT=3777]` | Select existing authorized root, approved host CLI and loopback port while stopped. |
| `make build` | Build the wrapper image; no model request. |
| `make up` / `make on` | Start the container and host bridge, checking readiness. |
| `make up NO_BUILD=1` | Start from the staged image with no build or pull. |
| `make down` / `make off` | Stop owned local processes/container; preserve state. |
| `make restart` | Stop and start the local service. |
| `make open` | Authenticate the browser through a private local file; no token in opener arguments or logs. |
| `make status` | Show local service state. |
| `make health` | Return success only when the wrapper and host bridge are ready. |
| `make logs` | Follow operational output; interrupting log viewing does not stop the service. |
| `make doctor` | Read prerequisites and local Docker availability without installing or changing settings. |

Use `make help` for the commands available in the checkout. Stop before changing roots, CLI path or port. Start the service from the same approved shell environment you normally use for Codex; the host bridge does not reconstruct or rewrite enterprise configuration.

`make restart NO_BUILD=1` also skips build and pull. Offline startup requires the image to be present already; the controller uses `--pull never` and fails if it is missing. `make build` is the explicit build operation.

Shutdown can interrupt active chats. Persisted incomplete turns become interrupted on restart; a later explicit message resumes the stored native thread where supported. The wrapper does not silently retry user work.

## Health

The local `/healthz` endpoint exposes minimal operational status. It does not return transcripts, roots or access tokens. Docker's container health check establishes wrapper liveness; the host `make health` command also checks bridge readiness.

Health checks never submit model work or inspect credentials. A healthy service does **not** establish that the CLI is authenticated, its model endpoint is reachable, its enterprise policy is correct, or the target host is deployment-approved. Verify those in the bounded real-environment smoke test.

The container has no published TCP port. Use the host loopback URL through the controller; a normal `ports:` mapping cannot reach a container-only loopback or Unix listener and is not part of this topology.

## Logs

Operational logs report process/listener state and bounded errors. Native CLI stderr, bearer tokens, launch fragments, request bodies and transcripts are not logged. Private transcript content belongs in the application's private state, not terminal logs.

Use `make logs` when diagnosing start, stop or bridge failures. Keep output private until reviewed and sanitized. Browser screenshots and debug traces can contain synthetic or real work content; do not attach them automatically to issues. Build-time package downloads and audit-tool requests are separate from application runtime traffic.

## Local files and state

Docker application history lives in the **Docker-managed named volume** `appdata`, under `/data/private` inside the container. The service runs as the ordinary configured numeric user and creates this mode-0700 private directory itself. Existing transcript ownership and file permissions are enforced; no privileged ownership initializer or relaxed history permissions are used.

The Compose project name is `t3local-` followed by a hash of the canonical checkout/archive directory. Its default volume name is `<project-name>_appdata`. `make down` does not pass `--volumes`; configuration and this volume remain intact. Keep the project directory stable: another checkout or a moved directory has a different namespace and does not automatically see the old history.

Host `.local-state` contains private configuration, generated Compose configuration and controller runtime records/logs. It does **not** contain the Docker transcript database. The fixed connection helper is captured privately into `.local-state/run/connection.json` when needed; this launch capability is not emitted by logs or health checks. Host files are ignored by Git.

| Application file | Purpose |
| --- | --- |
| `state.json` | Projects, chats, transcript/activity, local preferences and non-secret pending requests. |
| `store.lock` | Single-writer protection. |
| `connection.json` | Current private browser capability inside the application data directory; replaced on restart and removed on clean shutdown. The controller can keep a private temporary host cache separately. |
| `launch.html` | Owner-only static browser handoff; rotated with the session and removed on clean shutdown. Docker also creates a host handoff in `.local-state/run`. Never share or back up this temporary capability file. |
| `.state-*.tmp` | Atomic persistence intermediates. |

Native mode defaults to `~/.t3code-local`, or its explicit `--data-dir`; it does not share Docker history automatically. This version has no attachment upload/copy API; workspace text views read the original authorized file. The approved CLI owns its separate history and configuration.

### Backup and remove

Stop first with `make down`. Back up both the specific application volume and the separate private host configuration through your approved workflow. Treat the backup as sensitive; copying `.local-state` alone does not back up Docker chat history.

For Docker Desktop, identify this checkout's `<project-name>_appdata` volume in **Volumes** and use the approved volume export/backup workflow. For a CLI backup, the following identifies the same project namespace as the controller. Run it from the project directory and review the inspected volume name/labels before continuing:

```sh
make down
T3_BACKUP_PROJECT="$(python3 -c 'import hashlib; from pathlib import Path; print("t3local-" + hashlib.sha256(str(Path.cwd().resolve()).encode("utf8")).hexdigest()[:12])')"
docker volume inspect "${T3_BACKUP_PROJECT}_appdata"
```

Choose an existing private backup directory owned by your ordinary user. With the already staged application image, this example mounts only the identified volume read-only and that backup directory writable; it does not pull an image or require sudo:

```sh
T3_BACKUP_DIR=/absolute/private/backup
docker run --rm --pull never --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --mount "type=volume,src=${T3_BACKUP_PROJECT}_appdata,dst=/data,readonly" \
  --mount "type=bind,src=${T3_BACKUP_DIR},dst=/backup" \
  --entrypoint sh t3code-local:0.1.1 \
  -c 'umask 077; test ! -e /backup/history.tar.gz && tar -czf /backup/history.tar.gz -C /data private'
```

Use the actual staged image tag if it differs from `t3code-local:0.1.1`. The private host `.local-state/config.json` and generated Compose configuration need their own backup. Runtime control sockets, PID/nonce records and cached launch capabilities are temporary, not restore inputs. Restoring or migrating ownership is an explicit stopped-service operation; it is not performed automatically by startup.

If legacy bind-mounted history exists in `.local-state/data/state.json`, configuration stops and asks for an explicit migration. Preserve and back up that data; do not remove it merely to suppress the guard. Moving native history into Docker likewise requires an explicit reviewed transfer.

Stopping does not erase history. To erase Docker wrapper history intentionally, stop, identify and confirm the exact application volume and remove it through your approved Docker volume-management workflow. Remove private host configuration separately if desired. For native mode, confirm the exact dedicated `--data-dir` before removing it. The wrapper never deletes the CLI's independent credentials, history or installation-managed records. There is no automatic destructive reset step.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker unavailable | Run `make doctor`; start or obtain access through your approved existing Docker setup. No daemon/group/security change is performed by this project. |
| Remote Docker context rejected | Select the intended permitted local daemon. Host roots and approved CLI ownership cannot be inferred for a remote daemon. |
| Port occupied | Stop, configure an available `PORT`, then start. The listener remains on 127.0.0.1. |
| Browser asks for a token after restart | Run `make open` for the rotated capability. |
| Healthy wrapper but chat fails | Review the visible error and approved CLI availability. Health is not a model/authentication test; no fallback CLI is installed. |
| Root or symlink rejected | Check the explicit configured roots and actual canonical path. Do not broaden authorization merely to hide an error. |
| Git view refused | Custom includes, filters/textconv, lazy-fetch repositories or unsafe metadata can fail closed. See [security boundaries](SECURITY.md). |
| State malformed or locked | Preserve its bytes and inspect the owning instance. Do not delete a live lock or replace history automatically. |
| Legacy bind-mounted history detected | Stop and back up the legacy data, then complete an explicit reviewed migration. Startup does not discard or import it silently. |
| Container mount/ownership denied | Check permitted paths, UID/GID mapping and host policy. Do not disable SELinux or use privileges as a workaround. |

Separate chats and extra roots can touch shared files. A worktree isolates only its own repository. Keep deployment/browser/CLI/descendant network restrictions distinct; see [Security](SECURITY.md).
