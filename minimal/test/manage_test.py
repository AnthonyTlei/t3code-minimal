import argparse
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import signal
import socket
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("t3_manage", Path(__file__).resolve().parents[2] / "scripts/manage.py")
manage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manage)


class PackagingControlTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3m-", dir="/tmp")
        self.base = Path(self.temporary.name).resolve()
        self.project = self.base / "project"
        self.project.mkdir()
        self.workspace = self.base / "workspace with spaces"
        self.workspace.mkdir()
        self.cli = self.base / "synthetic-codex"
        self.cli.write_text("#!" + sys.executable + "\n", encoding="utf8")
        self.cli.chmod(0o755)
        self.patch = mock.patch.multiple(manage, PROJECT=self.project, STATE=self.project / ".local-state")
        self.patch.start()
        manage.prepare_state()

    def tearDown(self):
        self.patch.stop()
        self.temporary.cleanup()

    def config(self):
        return {"version": 1, "roots": [str(self.workspace)], "codex": str(self.cli), "port": 3777, "uid": os.getuid(), "gid": os.getgid()}

    def configure(self):
        with contextlib.redirect_stdout(io.StringIO()):
            manage.configure(argparse.Namespace(root=[str(self.workspace)], codex=str(self.cli), port=3777))

    def test_configuration_is_private_explicit_and_preserves_workspace_paths(self):
        self.configure()
        value = manage.load_config()
        self.assertEqual(value, self.config())
        generated = manage.private_json(manage.STATE / "compose.generated.json")
        service = generated["services"]["app"]
        self.assertEqual(service["command"][-2:], ["--root", str(self.workspace)])
        self.assertEqual(service["volumes"][0]["target"], str(self.workspace))
        self.assertFalse(service["volumes"][0]["read_only"])
        self.assertNotIn("/data", [volume["target"] for volume in service["volumes"]])
        self.assertIn("/data/private", service["command"])
        for file in (manage.STATE / "config.json", manage.STATE / "compose.generated.json"):
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        for directory in (manage.STATE, manage.STATE / "run"):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)

    def test_unsafe_private_paths_and_reserved_runtime_mounts_fail_closed(self):
        target = self.base / "unrelated"
        target.write_text("preserve", encoding="utf8")
        (manage.STATE / "config.json").symlink_to(target)
        with self.assertRaises(manage.UserError):
            self.configure()
        self.assertEqual(target.read_text(), "preserve")
        value = self.config()
        value["roots"] = ["/"]
        with self.assertRaises(manage.UserError):
            manage.validate_config(value)
        value = self.config()
        value["port"] = 80
        with self.assertRaises(manage.UserError):
            manage.validate_config(value)

    def test_relative_path_entries_cannot_select_workspace_tools(self):
        tools = self.base / "trusted-tools"
        tools.mkdir()
        trusted = tools / "synthetic-tool"
        trusted.write_text("#!" + sys.executable + "\n")
        trusted.chmod(0o755)
        malicious = self.workspace / "synthetic-tool"
        malicious.write_text("must not run")
        malicious.chmod(0o755)
        previous = Path.cwd()
        try:
            os.chdir(self.workspace)
            with mock.patch.dict(os.environ, {"PATH": "." + os.pathsep + str(tools)}):
                self.assertEqual(manage.executable("synthetic-tool"), str(trusted))
        finally:
            os.chdir(previous)

    def test_remote_docker_endpoint_is_not_contacted_and_context_takes_precedence(self):
        with mock.patch.object(manage, "executable", return_value="/trusted/docker"), mock.patch.object(manage.subprocess, "check_output") as inspect:
            with mock.patch.dict(os.environ, {"DOCKER_HOST": "tcp://unapproved.invalid:2376", "DOCKER_CONTEXT": ""}):
                with self.assertRaises(manage.UserError):
                    manage.docker_local()
                inspect.assert_not_called()
            inspect.return_value = "ssh://unapproved.invalid\n"
            with mock.patch.dict(os.environ, {"DOCKER_HOST": "unix:///safe.sock", "DOCKER_CONTEXT": "remote"}):
                with self.assertRaises(manage.UserError):
                    manage.docker_local()
            self.assertIn("remote", inspect.call_args.args[0])

    def test_live_manager_identity_blocks_reconfiguration_without_signalling_it(self):
        self.configure()
        manage.atomic_json(manage.STATE / "run" / "manager.json", {"pid": os.getpid(), "nonce": "synthetic"})
        before = (manage.STATE / "config.json").read_bytes()
        with self.assertRaises(manage.UserError):
            self.configure()
        self.assertEqual(before, (manage.STATE / "config.json").read_bytes())

    def test_atomic_manager_lock_does_not_unlink_an_active_control_socket(self):
        endpoint = manage.STATE / "run" / "control.sock"
        control = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        control.bind(str(endpoint))
        try:
            identity = endpoint.lstat().st_ino
            with manage.file_lock("manager.lock"):
                runtime = manage.Runtime(self.config(), "synthetic-nonce")
                with self.assertRaises(manage.UserError):
                    runtime.run()
            self.assertEqual(endpoint.lstat().st_ino, identity)
        finally:
            control.close()

    def test_slow_session_input_is_bounded_and_does_not_block_signals(self):
        runtime = manage.Runtime(self.config(), "synthetic-nonce")
        process = mock.Mock()
        process.poll.return_value = None
        runtime.children["one"] = {"process": process, "input": queue.Queue(maxsize=128), "input_stop": threading.Event(), "eof": threading.Event()}
        data = base64.b64encode(b"x" * manage.MAX_CHUNK).decode("ascii")
        for _ in range(128):
            runtime.dispatch({"type": "stdin", "id": "one", "data": data})
        runtime.dispatch({"type": "signal", "id": "one", "signal": "SIGTERM"})
        process.send_signal.assert_called_once_with(signal.SIGTERM)
        with self.assertRaises(manage.UserError):
            runtime.dispatch({"type": "stdin", "id": "one", "data": data})
        process.terminate.assert_called_once()

    def test_host_cli_uses_exact_arguments_inherited_environment_and_canonical_cwd(self):
        record = self.workspace / "launch.json"
        self.cli.write_text("#!" + sys.executable + "\n" + """import json,os,sys
with open('launch.json','w') as out: json.dump({'args':sys.argv[1:],'cwd':os.getcwd(),'marker':os.environ.get('T3_SYNTHETIC_MARKER')},out)
print('synthetic-ready',flush=True)
for line in sys.stdin:
 sys.stdout.write(line);sys.stdout.flush()
""", encoding="utf8")
        runtime = manage.Runtime(self.config(), "synthetic-nonce")
        frames = []
        output_seen = threading.Event()
        exited = threading.Event()

        def emit(value):
            frames.append(value)
            if value["type"] == "stdout" and b"test-input" in base64.b64decode(value["data"]):
                output_seen.set()
            if value["type"] == "exit":
                exited.set()

        runtime.emit = emit
        with mock.patch.dict(os.environ, {"T3_SYNTHETIC_MARKER": "unchanged"}):
            runtime.dispatch({"type": "open", "id": "native", "cwd": str(self.workspace)})
            runtime.dispatch({"type": "stdin", "id": "native", "data": base64.b64encode(b"test-input\n").decode("ascii")})
            self.assertTrue(output_seen.wait(3), "Expected subprocess output was not forwarded")
            runtime.dispatch({"type": "eof", "id": "native"})
            self.assertTrue(exited.wait(3), "Owned subprocess did not exit")
        actual = json.loads(record.read_text())
        self.assertEqual(actual, {"args": ["app-server"], "cwd": str(self.workspace), "marker": "unchanged"})
        self.assertEqual(frames[0], {"type": "opened", "id": "native"})

    def test_compose_project_is_unique_per_checkout_and_prebuilt_selection_is_local(self):
        with mock.patch.object(manage, "executable", return_value="/trusted/docker"):
            command = manage.command(self.config(), "ps")
            project_name = command[command.index("--project-name") + 1]
            self.assertTrue(project_name.startswith("t3local-"))
            with mock.patch.object(manage, "PROJECT", self.base / "second-checkout"):
                alternate = manage.command(self.config(), "ps")
            self.assertNotEqual(project_name, alternate[alternate.index("--project-name") + 1])
        (self.project / "dist").mkdir()
        (self.project / "dist/index.html").write_text("local bundle")
        self.assertEqual(manage.compose_env(self.config())["T3_BUILD_TARGET"], "prebuilt")

    def test_private_control_state_is_masked_when_the_checkout_is_an_authorized_root(self):
        config = self.config()
        config["roots"] = [str(self.project)]
        override = manage.compose_override(config)["services"]["app"]
        self.assertEqual(override["tmpfs"], [str(manage.STATE) + ":rw,nosuid,nodev,noexec,mode=000,size=64k"])
        self.assertEqual(override["volumes"][0]["target"], str(self.project))

    def test_operational_configuration_survives_removed_roots_or_cli_without_weakening_startup(self):
        self.configure()
        self.cli.unlink()
        self.workspace.rmdir()
        self.assertEqual(manage.load_config(live=False), self.config())
        with self.assertRaises((manage.UserError, FileNotFoundError)):
            manage.load_config()

    def test_output_queue_is_bounded_and_never_writes_on_the_dispatch_thread(self):
        runtime = manage.Runtime(self.config(), "synthetic-nonce")
        runtime.broker = mock.Mock()
        value = {"type": "stdout", "id": "native", "data": "x" * (512 * 1024)}
        for _ in range(15):
            runtime.emit(value)
        runtime.broker.stdin.fileno.assert_not_called()
        with self.assertRaises(manage.UserError):
            runtime.emit(value)
        self.assertTrue(runtime.stop.is_set())

    def test_modified_or_stale_generated_compose_configuration_cannot_start(self):
        self.configure()
        generated = manage.private_json(manage.STATE / "compose.generated.json")
        generated["services"]["app"]["command"] = ["unexpected"]
        manage.atomic_json(manage.STATE / "compose.generated.json", generated)
        with self.assertRaises(manage.UserError):
            manage.load_config()
        self.assertEqual(manage.load_config(live=False), self.config())

    def test_verified_docker_endpoint_is_pinned_without_changing_host_environment(self):
        with mock.patch.dict(os.environ, {"DOCKER_CONTEXT": "changed-remote-context", "DOCKER_HOST": "tcp://unapproved.invalid:2376"}):
            actual = manage.command(self.config(), "ps", docker_endpoint="unix:///approved/local.sock", docker_client="/trusted/docker")
            self.assertEqual(actual[:3], ["/trusted/docker", "--host", "unix:///approved/local.sock"])
            environment = manage.compose_env(self.config(), "unix:///approved/local.sock")
            self.assertNotIn("DOCKER_CONTEXT", environment)
            self.assertEqual(environment["DOCKER_HOST"], "unix:///approved/local.sock")
            self.assertEqual(os.environ["DOCKER_CONTEXT"], "changed-remote-context")
            self.assertEqual(os.environ["DOCKER_HOST"], "tcp://unapproved.invalid:2376")

    def test_legacy_bind_mounted_history_requires_explicit_migration(self):
        self.configure()
        legacy = manage.STATE / "data"
        legacy.mkdir()
        history = legacy / "state.json"
        history.write_text("synthetic history must be preserved")
        before = (manage.STATE / "config.json").read_bytes()
        with self.assertRaisesRegex(manage.UserError, "explicit migration"):
            self.configure()
        self.assertEqual(history.read_text(), "synthetic history must be preserved")
        self.assertEqual((manage.STATE / "config.json").read_bytes(), before)

    def test_private_connection_is_captured_from_fixed_helper_without_logging(self):
        value = {"url": "http://127.0.0.1:3777/#token=" + "a" * 43}
        output = io.StringIO()
        with mock.patch.object(manage, "compose_run", return_value=argparse.Namespace(stdout=json.dumps(value))) as execute, contextlib.redirect_stdout(output):
            self.assertEqual(manage.cache_connection(self.config()), value)
        self.assertEqual(output.getvalue(), "")
        execute.assert_called_once_with(self.config(), "exec", "-T", "app", "node", "minimal/server/connection.mjs", capture=True, timeout=10)
        cache = manage.STATE / "run" / "connection.json"
        self.assertEqual(manage.private_json(cache), value)
        self.assertEqual(stat.S_IMODE(cache.stat().st_mode), 0o600)
        for url in ("https://127.0.0.1:3777/#token=" + "a" * 43, "http://unapproved.invalid:3777/#token=" + "a" * 43, "http://user:password@127.0.0.1:3777/#token=" + "a" * 43):
            with self.assertRaises(manage.UserError):
                manage.validate_connection({"url": url}, 3777)

    def test_browser_launch_file_is_private_static_and_rotates_the_capability(self):
        first = {"url": "http://127.0.0.1:3777/#token=" + "a" * 43}
        second = {"url": "http://127.0.0.1:3777/#token=" + "b" * 43}
        uri = manage.launch_file(self.config(), first)
        file = manage.STATE / "run" / "launch.html"
        self.assertEqual(uri, file.as_uri())
        self.assertNotIn(first["url"], uri)
        self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        content = file.read_text(encoding="utf8")
        self.assertIn('<meta name="referrer" content="no-referrer">', content)
        self.assertIn("default-src 'none'; base-uri 'none'; form-action 'none'", content)
        self.assertIn('<meta http-equiv="refresh" content="0;url=' + first["url"] + '">', content)
        self.assertNotIn("<script", content)
        self.assertEqual(manage.launch_file(self.config(), second), uri)
        self.assertIn(second["url"], file.read_text())
        self.assertNotIn(first["url"], file.read_text())

    def test_browser_opener_receives_only_the_private_file_uri(self):
        value = {"url": "http://127.0.0.1:3777/#token=" + "a" * 43}
        output = io.StringIO()
        with mock.patch.object(manage, "probe_health", return_value=True), mock.patch.object(manage, "cache_connection", return_value=value), mock.patch.object(manage, "executable", return_value="/trusted/opener"), mock.patch.object(manage.subprocess, "Popen") as execute, contextlib.redirect_stdout(output):
            manage.operate(argparse.Namespace(operation="open"), self.config())
        self.assertEqual(execute.call_args.args[0], ["/trusted/opener", (manage.STATE / "run" / "launch.html").as_uri()])
        self.assertEqual(execute.call_args.kwargs, {"stdin": manage.subprocess.DEVNULL, "stdout": manage.subprocess.DEVNULL, "stderr": manage.subprocess.DEVNULL})
        self.assertNotIn("a" * 43, repr(execute.call_args))
        self.assertNotIn("a" * 43, output.getvalue())

    def test_browser_launch_rejects_unsafe_paths_and_destinations(self):
        value = {"url": "http://127.0.0.1:3777/#token=" + "a" * 43}
        outside = self.base / "unrelated.html"
        outside.write_text("preserve")
        file = manage.STATE / "run" / "launch.html"
        file.symlink_to(outside)
        with self.assertRaises(manage.UserError):
            manage.launch_file(self.config(), value)
        self.assertEqual(outside.read_text(), "preserve")
        file.unlink()
        (manage.STATE / "run").chmod(0o755)
        with self.assertRaises(manage.UserError):
            manage.launch_file(self.config(), value)
        self.assertFalse(file.exists())
        (manage.STATE / "run").chmod(0o700)
        for url in ("https://unapproved.invalid/#token=" + "a" * 43, value["url"] + '\"><script>bad</script>', "http://127.0.0.1:3777/?token=" + "a" * 43):
            with self.assertRaises(manage.UserError):
                manage.launch_file(self.config(), {"url": url})
        self.assertFalse(file.exists())
        runtime = manage.STATE / "run"
        saved_runtime = manage.STATE / "saved-run"
        unrelated = self.base / "unrelated-directory"
        unrelated.mkdir(mode=0o700)
        (unrelated / "launch.html").write_text("preserve")
        runtime.rename(saved_runtime)
        runtime.symlink_to(unrelated, target_is_directory=True)
        try:
            with self.assertRaises(manage.UserError):
                manage.launch_file(self.config(), value)
            with self.assertRaises(manage.UserError):
                manage.clear_launch_files()
            self.assertEqual((unrelated / "launch.html").read_text(), "preserve")
        finally:
            runtime.unlink()
            saved_runtime.rename(runtime)

    def test_cleanup_removes_private_browser_handoff_and_cache_without_deleting_history(self):
        value = {"url": "http://127.0.0.1:3777/#token=" + "a" * 43}
        sentinel = self.workspace / "synthetic-history-marker"
        sentinel.write_text("preserve")
        cache = manage.STATE / "run" / "connection.json"
        file = manage.STATE / "run" / "launch.html"
        runtime = manage.Runtime(self.config(), "synthetic-nonce")
        manage.atomic_json(manage.STATE / "run" / "manager.json", {"pid": os.getpid(), "nonce": runtime.nonce})
        manage.atomic_json(cache, value)
        manage.launch_file(self.config(), value)
        with contextlib.redirect_stdout(io.StringIO()):
            runtime.cleanup()
        self.assertFalse(cache.exists())
        self.assertFalse(file.exists())
        self.assertEqual(sentinel.read_text(), "preserve")
        manage.atomic_json(cache, value)
        manage.launch_file(self.config(), value)
        manage.stop_manager()
        self.assertFalse(cache.exists())
        self.assertFalse(file.exists())
        self.assertEqual(sentinel.read_text(), "preserve")

    def test_offline_start_never_pulls_or_implicitly_builds_an_image(self):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(manage, "manager_status", side_effect=[None, {"ready": True}]), mock.patch.object(manage, "probe_health", return_value=True), mock.patch.object(manage, "compose_run") as execute, mock.patch.object(manage, "cache_connection"), mock.patch.object(manage.subprocess, "Popen", return_value=process), contextlib.redirect_stdout(io.StringIO()):
            manage.start(self.config(), build=False)
        self.assertEqual(execute.call_args.args, (self.config(), "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "90"))


if __name__ == "__main__":
    unittest.main()
