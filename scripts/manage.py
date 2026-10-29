#!/usr/bin/env python3
"""Local Docker lifecycle and host-owned Codex transport. Python standard library only."""
import argparse
import base64
import binascii
from contextlib import contextmanager
import errno
import fcntl
import hmac
import hashlib
import html
import http.client
import json
import os
from pathlib import Path
import queue
import re
import secrets
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
from urllib.parse import urlparse

PROJECT = Path(__file__).resolve().parent.parent
STATE = PROJECT / ".local-state"
MAX_FRAME = 1024 * 1024
MAX_CHUNK = 64 * 1024
RESERVED = ("/app", "/data", "/run", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev")


class UserError(Exception):
    pass


def inside(root, candidate):
    try:
        return os.path.commonpath((str(root), str(candidate))) == str(root)
    except ValueError:
        return False


def checked(path, directory=False, optional=False):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return None
        raise UserError("A required private path is missing") from None
    if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)):
        raise UserError("A private path has an unsafe file type")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise UserError("Private state must belong to the current user")
    return info


def prepare_state():
    if checked(STATE, directory=True, optional=True) is None:
        STATE.mkdir(mode=0o700)
    STATE.chmod(0o700)
    for name in ("run",):
        child = STATE / name
        if checked(child, directory=True, optional=True) is None:
            child.mkdir(mode=0o700)
        child.chmod(0o700)


def private_json(path):
    before = checked(path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(str(path), flags)
    try:
        actual = os.fstat(descriptor)
        if (actual.st_dev, actual.st_ino) != (before.st_dev, before.st_ino) or actual.st_size > 128 * 1024:
            raise UserError("Private metadata changed or exceeds its size limit")
        with os.fdopen(descriptor, "r", encoding="utf8", closefd=False) as handle:
            value = json.load(handle)
    except (ValueError, UnicodeError):
        raise UserError("Private metadata is malformed; preserve it for inspection") from None
    finally:
        os.close(descriptor)
    return value


def atomic_text(path, value):
    checked(path, optional=True)
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(8))
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        checked(path, optional=True)
        os.replace(str(temporary), str(path))
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_json(path, value):
    atomic_text(path, json.dumps(value, indent=2) + "\n")


@contextmanager
def file_lock(name):
    lock = STATE / "run" / name
    checked(lock, optional=True)
    descriptor = os.open(str(lock), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise UserError("Unsafe lifecycle lock")
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UserError("Another local lifecycle operation or manager is already active") from None
        yield
    finally:
        os.close(descriptor)


def executable(command):
    if not isinstance(command, str) or not command or "\0" in command:
        raise UserError("Select an existing approved executable")
    if os.path.isabs(command) or os.sep in command:
        candidates = [Path(command).absolute()]
    else:
        candidates = [Path(directory) / command for directory in os.environ.get("PATH", "").split(os.pathsep) if os.path.isabs(directory)]
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            if resolved.is_file() and os.access(str(resolved), os.X_OK):
                return str(resolved)
        except (OSError, RuntimeError):
            pass
    raise UserError("Executable unavailable in an absolute PATH directory; select its approved absolute path")


def validate_config(value, live=True):
    if not isinstance(value, dict) or set(value) != {"version", "roots", "codex", "port", "uid", "gid"} or value["version"] != 1:
        raise UserError("Unsupported local configuration")
    roots = value["roots"]
    if not isinstance(roots, list) or not 1 <= len(roots) <= 32 or not all(isinstance(root, str) for root in roots) or len(set(roots)) != len(roots):
        raise UserError("Choose one to 32 distinct explicit workspace roots")
    for root in roots:
        if not os.path.isabs(root) or "\0" in root or os.path.normpath(root) != root:
            raise UserError("Workspace roots must remain canonical existing directories")
        if live and (str(Path(root).resolve(strict=True)) != root or not Path(root).is_dir()):
            raise UserError("Workspace roots must remain canonical existing directories")
        if root == "/" or any(inside(reserved, root) or inside(root, reserved) for reserved in RESERVED):
            raise UserError("Workspace root overlaps the container's reserved runtime paths")
    if not isinstance(value["port"], int) or isinstance(value["port"], bool) or not 1024 <= value["port"] <= 65535:
        raise UserError("Choose a loopback port between 1024 and 65535")
    for key, expected in (("uid", os.getuid()), ("gid", os.getgid())):
        if value[key] != expected:
            raise UserError("Configuration belongs to a different OS user; configure it for this user")
    if value["uid"] == 0:
        raise UserError("Run the local wrapper as your ordinary non-root user")
    if not isinstance(value["codex"], str) or not os.path.isabs(value["codex"]) or "\0" in value["codex"] or os.path.normpath(value["codex"]) != value["codex"]:
        raise UserError("The approved Codex executable changed or is unavailable; configure its absolute path again")
    if live and executable(value["codex"]) != value["codex"]:
        raise UserError("The approved Codex executable changed or is unavailable; configure its absolute path again")
    return value


def load_config(live=True):
    checked(STATE, directory=True)
    config = validate_config(private_json(STATE / "config.json"), live=live)
    if live and private_json(STATE / "compose.generated.json") != compose_override(config):
        raise UserError("Generated Compose settings do not match the explicit configuration; run make configure again")
    return config


def compose_override(config):
    command = ["--host-bridge", "--socket", "/run/t3/http.sock", "--data-dir", "/data/private", "--port", str(config["port"])]
    for root in config["roots"]:
        command.extend(("--root", root))
    volumes = [{"type": "bind", "source": root, "target": root, "read_only": False, "bind": {"create_host_path": False}} for root in config["roots"]]
    service = {"command": command, "volumes": volumes}
    if any(inside(root, STATE) for root in config["roots"]):
        if ":" in str(STATE):
            raise UserError("The checkout path cannot contain ':' when its private state needs a container mask")
        service["tmpfs"] = [str(STATE) + ":rw,nosuid,nodev,noexec,mode=000,size=64k"]
    return {"services": {"app": service}}


def command(config, *arguments, docker_endpoint=None, docker_client=None):
    project_name = "t3local-" + hashlib.sha256(str(PROJECT).encode("utf8")).hexdigest()[:12]
    connection = ["--host", docker_endpoint] if docker_endpoint else []
    return [docker_client or executable("docker"), *connection, "compose", "--project-name", project_name, "--project-directory", str(PROJECT), "--file", str(PROJECT / "compose.yaml"), "--file", str(STATE / "compose.generated.json"), *arguments]


def compose_env(config, docker_endpoint=None):
    result = dict(os.environ)
    result.update(LOCAL_UID=str(config["uid"]), LOCAL_GID=str(config["gid"]), T3_PORT=str(config["port"]))
    if docker_endpoint:
        result.pop("DOCKER_CONTEXT", None)
        result["DOCKER_HOST"] = docker_endpoint
    if not (PROJECT / "minimal/web/src/main.tsx").is_file() and (PROJECT / "dist/index.html").is_file():
        result["T3_BUILD_TARGET"] = "prebuilt"
    return result


def docker_local(include_endpoint=False):
    docker = executable("docker")
    context = os.environ.get("DOCKER_CONTEXT")
    endpoint = os.environ.get("DOCKER_HOST") if not context else None
    if not endpoint:
        arguments = [docker, "context", "inspect"] + ([context] if context else []) + ["--format", "{{.Endpoints.docker.Host}}"]
        try:
            endpoint = subprocess.check_output(arguments, stderr=subprocess.DEVNULL, timeout=10, text=True).strip()
        except (subprocess.SubprocessError, OSError):
            raise UserError("Could not verify the Docker context; no daemon operation was attempted") from None
    parsed = urlparse(endpoint)
    if parsed.scheme != "unix" or parsed.netloc or not parsed.path.startswith("/") or parsed.query or parsed.fragment:
        raise UserError("Only an existing local Unix-socket Docker context is supported; remote contexts are not contacted")
    return (docker, endpoint) if include_endpoint else docker


def compose_run(config, *arguments, capture=False, timeout=None):
    docker, endpoint = docker_local(include_endpoint=True)
    try:
        return subprocess.run(command(config, *arguments, docker_endpoint=endpoint, docker_client=docker), env=compose_env(config, endpoint), cwd=str(PROJECT), check=True,
                              stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None,
                              text=True, timeout=timeout)
    except subprocess.CalledProcessError:
        raise UserError("Docker Compose failed; inspect the local Docker/Compose status") from None


def probe_health(port):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", "/healthz", headers={"Host": "127.0.0.1:" + str(port)})
        response = connection.getresponse()
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            return False
        value = json.loads(raw.decode("utf8"))
        return value.get("status") == "ok" and value.get("ready") is True
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def validate_connection(value, port):
    if not isinstance(value, dict) or set(value) != {"url"} or not isinstance(value["url"], str) or len(value["url"]) > 4096:
        raise UserError("Private launch URL is invalid")
    parsed = urlparse(value["url"])
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != port or parsed.path != "/" or parsed.query or parsed.username or parsed.password or not re.fullmatch(r"token=[A-Za-z0-9_-]{43,128}", parsed.fragment):
        raise UserError("Private launch URL is invalid")
    return value


def cache_connection(config):
    result = compose_run(config, "exec", "-T", "app", "node", "minimal/server/connection.mjs", capture=True, timeout=10)
    if len(result.stdout) > 4096:
        raise UserError("Private connection helper exceeded its output limit")
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise UserError("Private connection helper returned invalid metadata") from None
    value = validate_connection(value, config["port"])
    atomic_json(STATE / "run" / "connection.json", value)
    return value


def private_runtime_directory():
    for directory in (STATE, STATE / "run"):
        info = checked(directory, directory=True)
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise UserError("Browser launch files require private parent directories")


def launch_file(config, value):
    """Keep the bearer capability in an owner-only file, never opener argv."""
    value = validate_connection(value, config["port"])
    private_runtime_directory()
    file = STATE / "run" / "launch.html"
    content = (
        '<!doctype html>\n<meta charset="utf-8">\n'
        '<meta name="referrer" content="no-referrer">\n'
        '<meta http-equiv="Content-Security-Policy" '
        'content="default-src \'none\'; base-uri \'none\'; form-action \'none\'">\n'
        '<meta http-equiv="refresh" content="0;url='
        + html.escape(value["url"], quote=True)
        + '">\n<title>Open T3 Code Local</title>\n'
        '<p>Opening your local workspace.</p>\n'
    )
    atomic_text(file, content)
    return file.as_uri()


def clear_launch_files():
    private_runtime_directory()
    for name in ("connection.json", "launch.html"):
        file = STATE / "run" / name
        if checked(file, optional=True) is not None:
            file.unlink()


def control_message(message, timeout=2):
    record = private_json(STATE / "run" / "manager.json")
    if not isinstance(record, dict) or set(record) != {"pid", "nonce"} or not isinstance(record["pid"], int) or not isinstance(record["nonce"], str):
        raise UserError("Malformed manager identity; no process was stopped")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(STATE / "run" / "control.sock"))
        client.sendall(json.dumps({"command": message, "nonce": record["nonce"]}).encode("utf8") + b"\n")
        data = bytearray()
        while b"\n" not in data and len(data) <= 4096:
            chunk = client.recv(4096)
            if not chunk:
                break
            data.extend(chunk)
        result = json.loads(data.decode("utf8"))
        if result.get("pid") != record["pid"]:
            raise UserError("Manager identity did not match; no process was stopped")
        if not result.get("ok"):
            raise UserError("The local manager rejected this control request")
        return result
    except (OSError, ValueError):
        raise UserError("The local manager control socket is unavailable; no PID was signalled") from None
    finally:
        client.close()


def manager_status():
    if checked(STATE / "run" / "manager.json", optional=True) is None:
        return None
    try:
        return control_message("status")
    except UserError:
        return None


def write_pipe(handle, data):
    view = memoryview(data)
    while view:
        count = os.write(handle.fileno(), view)
        view = view[count:]


class Runtime:
    def __init__(self, config, nonce):
        self.config = config
        self.nonce = nonce
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.write_lock = threading.Lock()
        self.output = queue.Queue(maxsize=256)
        self.output_bytes = 0
        self.children_lock = threading.Lock()
        self.children = {}
        self.io_processes = set()
        self.http_sockets = set()
        self.slots = threading.BoundedSemaphore(16)
        self.broker = None
        self.http = None
        self.control = None
        self.control_serving = False
        self.docker_client = None
        self.docker_endpoint = None
        self.root_identity = {root: (os.stat(root).st_dev, os.stat(root).st_ino) for root in config["roots"]}

    def emit(self, value):
        data = json.dumps(value, separators=(",", ":")).encode("utf8") + b"\n"
        if len(data) > MAX_FRAME:
            raise UserError("Bridge frame exceeded its limit")
        with self.write_lock:
            if self.output_bytes + len(data) > 8 * 1024 * 1024 or self.output.full():
                self.stop.set()
                raise UserError("Bridge output exceeded its bounded queue")
            self.output.put_nowait(data)
            self.output_bytes += len(data)

    def broker_writer(self):
        try:
            while not self.stop.is_set():
                try:
                    data = self.output.get(timeout=0.1)
                except queue.Empty:
                    continue
                with self.write_lock:
                    self.output_bytes -= len(data)
                write_pipe(self.broker.stdin, data)
        except (OSError, ValueError):
            self.stop.set()

    def cwd(self, requested):
        if not isinstance(requested, str) or not os.path.isabs(requested) or "\0" in requested:
            raise UserError("Invalid working directory")
        canonical = str(Path(requested).resolve(strict=True))
        for root, identity in self.root_identity.items():
            current = os.lstat(root)
            if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != identity:
                raise UserError("An authorized root changed")
        if not any(inside(root, canonical) for root in self.config["roots"]) or not Path(canonical).is_dir():
            raise UserError("Working directory is outside the authorized roots")
        return canonical

    def cli_output(self, identifier, process):
        try:
            while not self.stop.is_set():
                chunk = os.read(process.stdout.fileno(), MAX_CHUNK)
                if not chunk:
                    break
                self.emit({"type": "stdout", "id": identifier, "data": base64.b64encode(chunk).decode("ascii")})
        except (OSError, UserError):
            pass

    def cli_wait(self, identifier, process, output):
        code = process.wait()
        output.join(timeout=1)
        with self.children_lock:
            entry = self.children.pop(identifier, None)
            if entry:
                entry["input_stop"].set()
        try:
            self.emit({"type": "exit", "id": identifier, "code": code if code >= 0 else None,
                       "signal": signal.Signals(-code).name if code < 0 else None})
        except (OSError, UserError):
            pass
        for handle in (process.stdin, process.stdout):
            try:
                handle.close()
            except OSError:
                pass

    def cli_input(self, entry):
        process = entry["process"]
        try:
            while not self.stop.is_set() and not entry["input_stop"].is_set():
                try:
                    data = entry["input"].get(timeout=0.1)
                except queue.Empty:
                    if entry["eof"].is_set():
                        break
                    continue
                write_pipe(process.stdin, data)
        except (OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

    def dispatch(self, value):
        if not isinstance(value, dict):
            raise UserError("Invalid bridge frame")
        kind = value.get("type")
        if kind == "ready" and set(value) == {"type"}:
            self.ready.set()
            return
        identifier = value.get("id")
        if not isinstance(identifier, str) or not identifier or len(identifier) > 200:
            raise UserError("Invalid session identifier")
        if kind == "open" and set(value) == {"type", "id", "cwd"}:
            cwd = self.cwd(value["cwd"])
            with self.children_lock:
                if identifier in self.children or len(self.children) >= 32:
                    raise UserError("Session limit or duplicate session")
                process = subprocess.Popen([self.config["codex"], "app-server"], cwd=cwd,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           shell=False, bufsize=0, close_fds=True)
                entry = {"process": process, "input": queue.Queue(maxsize=128), "input_stop": threading.Event(), "eof": threading.Event()}
                self.children[identifier] = entry
            self.emit({"type": "opened", "id": identifier})
            threading.Thread(target=self.cli_input, args=(entry,), daemon=True).start()
            output = threading.Thread(target=self.cli_output, args=(identifier, process), daemon=True)
            output.start()
            threading.Thread(target=self.cli_wait, args=(identifier, process, output), daemon=True).start()
            return
        with self.children_lock:
            entry = self.children.get(identifier)
        if entry is None:
            raise UserError("Session is no longer active")
        process = entry["process"]
        if kind == "stdin" and set(value) == {"type", "id", "data"}:
            encoded = value["data"]
            if not isinstance(encoded, str) or len(encoded) > ((MAX_CHUNK + 2) // 3) * 4:
                raise UserError("Input chunk exceeds its limit")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise UserError("Malformed input encoding") from None
            if len(data) > MAX_CHUNK:
                raise UserError("Input chunk exceeds its limit")
            if entry["eof"].is_set():
                raise UserError("Input stream is already closed")
            try:
                entry["input"].put_nowait(data)
            except queue.Full:
                if process.poll() is None:
                    process.terminate()
                raise UserError("Session input exceeded its bounded queue") from None
        elif kind == "eof" and set(value) == {"type", "id"}:
            entry["eof"].set()
        elif kind == "signal" and set(value) == {"type", "id", "signal"} and value["signal"] in ("SIGTERM", "SIGKILL"):
            if process.poll() is None:
                process.send_signal(getattr(signal, value["signal"]))
        else:
            raise UserError("Unsupported bridge operation")

    def broker_reader(self):
        try:
            while not self.stop.is_set():
                line = self.broker.stdout.readline(MAX_FRAME + 1)
                if not line:
                    break
                if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                    raise UserError("Bridge frame exceeds its limit")
                value = None
                try:
                    value = json.loads(line.decode("utf8"))
                    self.dispatch(value)
                except (UserError, ValueError, OSError, RecursionError):
                    identifier = value.get("id") if isinstance(value, dict) else None
                    if isinstance(identifier, str) and len(identifier) <= 200:
                        self.emit({"type": "failure", "id": identifier, "message": "Host CLI bridge rejected the operation"})
                    else:
                        raise UserError("Invalid bridge operation") from None
        except (UserError, OSError):
            print("The local CLI bridge stopped; no native work was retried.", flush=True)
        finally:
            self.ready.clear()
            self.stop.set()

    def http_client(self, request):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        process = None
        try:
            request.settimeout(2)
            initial = request.recv(MAX_CHUNK)
            if not initial:
                return
            request.settimeout(None)
            process = subprocess.Popen(command(self.config, "exec", "-T", "app", "node", "minimal/server/bridge-client.mjs", "http", docker_endpoint=self.docker_endpoint, docker_client=self.docker_client),
                                       env=compose_env(self.config, self.docker_endpoint), cwd=str(PROJECT), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
            with self.children_lock:
                self.io_processes.add(process)
                self.http_sockets.add(request)
            write_pipe(process.stdin, initial)

            def inbound():
                try:
                    while not self.stop.is_set():
                        data = request.recv(MAX_CHUNK)
                        if not data:
                            break
                        write_pipe(process.stdin, data)
                except OSError:
                    pass
                finally:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass

            threading.Thread(target=inbound, daemon=True).start()
            while not self.stop.is_set():
                data = os.read(process.stdout.fileno(), MAX_CHUNK)
                if not data:
                    break
                request.sendall(data)
        except (OSError, UserError):
            pass
        finally:
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()
            if process:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                with self.children_lock:
                    self.io_processes.discard(process)
                    self.http_sockets.discard(request)
            self.slots.release()

    def run(self):
        with file_lock("manager.lock"):
            record = STATE / "run" / "manager.json"
            if record.exists():
                value = private_json(record)
                if not isinstance(value, dict) or not isinstance(value.get("pid"), int) or value["pid"] < 1:
                    raise UserError("Inspect the malformed manager identity before restarting")
                try:
                    os.kill(value["pid"], 0)
                except ProcessLookupError:
                    pass
                else:
                    raise UserError("Existing manager identity is live; authenticated stop is required")
            try:
                self.serve()
            finally:
                self.cleanup()

    def serve(self):
        runtime = self
        self.docker_client, self.docker_endpoint = docker_local(include_endpoint=True)
        self.http = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.http.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.http.bind(("127.0.0.1", self.config["port"]))
        self.http.listen(16)
        self.http.settimeout(0.5)

        class Control(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(2)
                try:
                    data = bytearray()
                    while b"\n" not in data and len(data) <= 4096:
                        chunk = self.request.recv(4096)
                        if not chunk:
                            break
                        data.extend(chunk)
                    value = json.loads(data.decode("utf8"))
                    valid = isinstance(value, dict) and set(value) == {"nonce", "command"} and isinstance(value["nonce"], str) and hmac.compare_digest(value["nonce"], runtime.nonce)
                    operation = value.get("command") if valid else None
                    ok = operation in ("status", "stop")
                    self.request.sendall(json.dumps({"ok": ok, "pid": os.getpid(), "ready": runtime.ready.is_set()}).encode("utf8") + b"\n")
                    if ok and operation == "stop":
                        runtime.stop.set()
                except (OSError, ValueError):
                    pass

        control_path = STATE / "run" / "control.sock"
        if control_path.exists() or control_path.is_symlink():
            info = control_path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise UserError("Unsafe existing control socket")
            control_path.unlink()
        self.control = socketserver.ThreadingUnixStreamServer(str(control_path), Control)
        self.control.daemon_threads = True
        control_path.chmod(0o600)
        atomic_json(STATE / "run" / "manager.json", {"pid": os.getpid(), "nonce": self.nonce})
        threading.Thread(target=self.control.serve_forever, daemon=True).start()
        self.control_serving = True
        self.broker = subprocess.Popen(command(self.config, "exec", "-T", "app", "node", "minimal/server/bridge-client.mjs", "broker", docker_endpoint=self.docker_endpoint, docker_client=self.docker_client),
                                       env=compose_env(self.config, self.docker_endpoint), cwd=str(PROJECT), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        threading.Thread(target=self.broker_writer, daemon=True).start()
        threading.Thread(target=self.broker_reader, daemon=True).start()
        print("Local wrapper gateway listening on 127.0.0.1:" + str(self.config["port"]), flush=True)
        for name in ("SIGTERM", "SIGINT"):
            signal.signal(getattr(signal, name), lambda *_: self.stop.set())
        while not self.stop.is_set():
            try:
                client, _ = self.http.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self.http_client, args=(client,), daemon=True).start()

    def cleanup(self):
        self.stop.set()
        self.ready.clear()
        if self.http:
            self.http.close()
        if self.control:
            if self.control_serving:
                self.control.shutdown()
            self.control.server_close()
        with self.children_lock:
            processes = [item["process"] for item in self.children.values()] + list(self.io_processes)
            sockets = list(self.http_sockets)
        if self.broker:
            processes.append(self.broker)
        for client in sockets:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        record = STATE / "run" / "manager.json"
        try:
            value = private_json(record)
            if value.get("pid") == os.getpid() and value.get("nonce") == self.nonce:
                record.unlink()
                (STATE / "run" / "control.sock").unlink(missing_ok=True)
                clear_launch_files()
        except (UserError, OSError):
            pass
        print("Local wrapper gateway stopped; private data was preserved.", flush=True)


def stop_manager():
    record = STATE / "run" / "manager.json"
    if checked(record, optional=True) is None:
        clear_launch_files()
        return
    try:
        control_message("stop")
    except UserError:
        identity = private_json(record)
        try:
            os.kill(identity["pid"], 0)
        except ProcessLookupError:
            record.unlink()
            clear_launch_files()
            return
        raise UserError("Manager control is unavailable while its PID is live; no process was signalled") from None
    deadline = time.monotonic() + 12
    while record.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    if record.exists():
        raise UserError("Manager shutdown has not finished; no PID was forcibly signalled")
    clear_launch_files()


def configure(args):
    prepare_state()
    legacy = STATE / "data"
    if legacy.exists() or legacy.is_symlink():
        checked(legacy, directory=True)
        history = legacy / "state.json"
        if history.exists() or history.is_symlink():
            raise UserError("Legacy bind-mounted history exists in .local-state/data; stop the app and complete an explicit migration before configuring named-volume storage")
    if (STATE / "run" / "manager.json").exists():
        stop_record = private_json(STATE / "run" / "manager.json")
        if not isinstance(stop_record, dict) or not isinstance(stop_record.get("pid"), int):
            raise UserError("Inspect the malformed manager identity before reconfiguring")
        try:
            os.kill(stop_record["pid"], 0)
        except ProcessLookupError:
            pass
        else:
            raise UserError("Stop the existing manager before changing its configuration")
    if manager_status():
        raise UserError("Stop the running app before changing its configuration")
    roots = args.root or ([os.environ["ROOT"]] if os.environ.get("ROOT") else [])
    if not roots:
        raise UserError("Choose an explicit root: make configure ROOT=/absolute/workspace CODEX=/approved/codex")
    value = {"version": 1, "roots": [str(Path(root).resolve(strict=True)) for root in roots],
             "codex": executable(args.codex or os.environ.get("CODEX") or "codex"),
             "port": args.port if args.port is not None else int(os.environ.get("PORT") or "3777"), "uid": os.getuid(), "gid": os.getgid()}
    validate_config(value)
    generated = compose_override(value)
    atomic_json(STATE / "config.json", value)
    atomic_json(STATE / "compose.generated.json", generated)
    print("Configured " + str(len(roots)) + " explicit root(s); CLI credentials and configuration were not read or copied.")


def start(config, build=True):
    if manager_status():
        if probe_health(config["port"]):
            cache_connection(config)
            print("Already running and healthy.")
            return
        raise UserError("A manager is already running but not healthy; inspect status/logs before restarting")
    compose_run(config, "up", "-d", "--build" if build else "--no-build", "--pull", "never", "--wait", "--wait-timeout", "90")
    log = STATE / "run" / "bridge.log"
    checked(log, optional=True)
    descriptor = os.open(str(log), os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "ab") as handle:
        process = subprocess.Popen([sys.executable, str(PROJECT / "scripts/manage.py"), "_serve"],
                                   cwd=str(PROJECT), stdin=subprocess.DEVNULL, stdout=handle, stderr=handle,
                                   start_new_session=True, close_fds=True)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise UserError("Host bridge could not start; inspect make logs (container remains available for diagnosis)")
        if manager_status() and probe_health(config["port"]):
            cache_connection(config)
            print("Running at http://127.0.0.1:" + str(config["port"]) + " — use make open for the private browser session.")
            return
        time.sleep(0.2)
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    raise UserError("Host bridge did not become ready; inspect make logs")


def logs(config, follow=True):
    log = STATE / "run" / "bridge.log"
    if checked(log, optional=True):
        lines = log.read_text(encoding="utf8", errors="replace").splitlines()[-30:]
        if lines:
            print("Host bridge (recent):\n" + "\n".join(lines), flush=True)
    compose_run(config, "logs", "--tail", "100", *(('--follow',) if follow else ()), "app")


def operate(args, config):
    if args.operation == "_serve":
        if manager_status():
            raise UserError("A host manager is already running")
        runtime = Runtime(config, secrets.token_hex(32))
        try:
            runtime.run()
        except Exception:
            raise UserError("Local manager could not continue; private data was preserved") from None
    elif args.operation == "up":
        start(config, not args.no_build)
    elif args.operation == "build":
        compose_run(config, "build", "app")
    elif args.operation == "down":
        stop_manager()
        compose_run(config, "down")
        print("Stopped. Configuration and local history were preserved.")
    elif args.operation == "restart":
        stop_manager()
        compose_run(config, "down")
        start(config, not args.no_build)
    elif args.operation == "status":
        status = manager_status()
        print("Host bridge: " + ("ready" if status and status.get("ready") else "stopped or unavailable"))
        print("App health: " + ("ready" if probe_health(config["port"]) else "not ready"))
        compose_run(config, "ps")
    elif args.operation == "health":
        if not manager_status() or not probe_health(config["port"]):
            raise UserError("Not ready: wrapper HTTP or host CLI bridge is unavailable")
        print("Healthy: loopback HTTP and host CLI bridge are ready. CLI login/model availability was not probed.")
    elif args.operation == "logs":
        logs(config, not args.no_follow)
    elif args.operation == "open":
        if not probe_health(config["port"]):
            raise UserError("Start the healthy app before opening its browser session")
        value = cache_connection(config)
        uri = launch_file(config, value)
        opener = executable("open" if sys.platform == "darwin" else "xdg-open")
        subprocess.Popen([opener, uri], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("Opened the private local session. Its token was not printed.")


def main():
    if sys.version_info < (3, 8):
        raise UserError("Python 3.8 or later is required for host-side container operations")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("configure", "build", "up", "down", "restart", "status", "health", "logs", "open", "doctor", "_serve"))
    parser.add_argument("--root", action="append")
    parser.add_argument("--codex")
    parser.add_argument("--port", type=int)
    parser.add_argument("--no-build", action="store_true", default=os.environ.get("NO_BUILD") == "1")
    parser.add_argument("--no-follow", action="store_true")
    args = parser.parse_args()
    if args.operation == "configure":
        prepare_state()
        with file_lock("operation.lock"):
            configure(args)
        return
    if args.operation == "doctor":
        docker, endpoint = docker_local(include_endpoint=True)
        print("Python " + sys.version.split()[0] + "; local Unix-socket Docker context verified.")
        environment = dict(os.environ)
        environment.pop("DOCKER_CONTEXT", None)
        environment["DOCKER_HOST"] = endpoint
        for command_args in ([docker, "--host", endpoint, "version", "--format", "client={{.Client.Version}} server={{if .Server}}{{.Server.Version}}{{end}}"], [docker, "--host", endpoint, "compose", "version"]):
            subprocess.run(command_args, env=environment, check=True)
        if (STATE / "config.json").exists():
            config = load_config()
            print("Configuration valid; approved executable exists; " + str(len(config["roots"])) + " root(s). No CLI process was started.")
        else:
            print("Not configured yet. Use make configure.")
        return
    if args.operation in ("up", "down", "restart", "build"):
        with file_lock("operation.lock"):
            return operate(args, load_config(live=args.operation != "down"))
    return operate(args, load_config(live=args.operation not in ("status", "health", "logs", "open")))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted; make status shows the current service state.", file=sys.stderr)
        sys.exit(130)
    except (UserError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("T3 Code Local: " + (str(error) if isinstance(error, UserError) else "Local operation failed; no security setting was changed."), file=sys.stderr)
        sys.exit(1)
