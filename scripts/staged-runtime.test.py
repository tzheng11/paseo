"""Hermetic tests for operator packaging; never uses the live daemon port."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("staged_runtime", Path(__file__).with_name("staged-runtime.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class PortProbeTests(unittest.TestCase):
    def test_time_wait_is_reusable_like_the_daemon(self):
        with socket.socket() as server, socket.socket() as client:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            port = server.getsockname()[1]
            server.listen(1)
            client.settimeout(2)
            client.connect(("127.0.0.1", port))
            with server.accept()[0] as accepted:
                accepted.settimeout(2)
                # The server actively closes, leaving its local endpoint in TIME_WAIT.
                accepted.shutdown(socket.SHUT_WR)
                self.assertEqual(client.recv(1), b"")
                client.close()
                self.assertEqual(accepted.recv(1), b"")
        with socket.socket() as old_probe:
            with self.assertRaises(OSError) as failure:
                old_probe.bind(("127.0.0.1", port))
            self.assertEqual(failure.exception.errno, errno.EADDRINUSE)
        inspected = []
        runtime.assert_port_free(port, lambda: inspected.append(True) or [])
        self.assertEqual(inspected, [True])

    def test_listener_check_refuses_before_socket_creation(self):
        with patch.object(runtime.socket, "socket") as probe:
            with self.assertRaisesRegex(runtime.PortUnavailable, "listener"):
                runtime.assert_port_free(12345, lambda: [123])
            probe.assert_not_called()

    def test_listener_inspection_failure_is_not_absence(self):
        def failed_read():
            raise RuntimeError("incomplete listener metadata")
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            runtime.assert_port_free(12345, failed_read)

    def test_bind_still_refuses_a_live_listener(self):
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            # A raced or incomplete empty listener result must still fail the bind.
            with self.assertRaisesRegex(runtime.PortUnavailable, "cannot be bound"):
                runtime.assert_port_free(server.getsockname()[1], lambda: [])

    def test_missing_listener_result_is_not_absence(self):
        with self.assertRaisesRegex(runtime.PortUnavailable, "incomplete"):
            runtime.assert_port_free(12345, lambda: None)

    def test_probe_closes_its_socket(self):
        with socket.socket() as selected:
            selected.bind(("127.0.0.1", 0))
            port = selected.getsockname()[1]
        runtime.assert_port_free(port, lambda: [])
        with socket.socket() as next_owner:
            next_owner.bind(("127.0.0.1", port))


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="paseo wrapper ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.bin = self.root / "packet with spaces" / "bin"
        self.bin.mkdir(parents=True)
        self.links = self.root / "public bin"
        self.links.mkdir()
        self.cwd = self.root / "unrelated cwd"
        self.cwd.mkdir()
        recorder = self.root / "record.py"
        recorder.write_text("import json, os, sys\nprint(json.dumps({'argv':sys.argv[1:],'cli':os.environ['PASEO_CLI'],'path':os.environ['PATH'],'cwd':os.getcwd()}))\n")
        node = self.bin / "node"
        node.write_text('#!/bin/sh\nexec "$TEST_PYTHON" "$TEST_RECORDER" "$@"\n')
        node.chmod(0o755)
        hostile = self.root / "other tools"
        hostile.mkdir()
        (hostile / "node").write_text("#!/bin/sh\nexit 99\n")
        (hostile / "node").chmod(0o755)
        self.env = {
            "PATH": f"{hostile}:/usr/bin:/bin",
            "HOME": str(self.root),
            "CDPATH": "/unexpected/cdpath",
            "TEST_PYTHON": sys.executable,
            "TEST_RECORDER": str(recorder),
        }
        self.entries = {
            "paseo": "packages/cli/dist/index.js",
            "paseo-server": "packages/server/dist/scripts/supervisor-entrypoint.js",
        }
        for command, entry in self.entries.items():
            entry_path = self.bin.parent / "runtime" / entry
            entry_path.parent.mkdir(parents=True, exist_ok=True)
            entry_path.touch()
            wrapper = self.bin / command
            wrapper.write_text(runtime.render_wrapper(command))
            wrapper.chmod(0o755)

    def invoke(self, path, *args, env=None):
        return subprocess.run([str(path), *args], cwd=self.cwd, env=env or self.env,
                              text=True, capture_output=True, timeout=5)

    def assert_packet_execution(self, path, command, env=None):
        args = ["--literal", "two words", "$(must-not-execute)", "", "line\nbreak", "*"]
        result = self.invoke(path, *args, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        recorded = json.loads(result.stdout)
        self.assertEqual(Path(recorded["argv"][0]).resolve(),
                         self.bin.parent / "runtime" / self.entries[command])
        self.assertEqual(recorded["argv"][1:], args)
        self.assertEqual(recorded["cli"], str(self.bin / "paseo"))
        self.assertEqual(recorded["path"].split(":")[0], str(self.bin))
        self.assertEqual(recorded["cwd"], str(self.cwd))

    def test_both_commands_direct_and_through_absolute_relative_and_multihop_links(self):
        for command in self.entries:
            with self.subTest(command=command):
                self.assert_packet_execution(self.bin / command, command)
                absolute = self.links / (command + "-absolute")
                absolute.symlink_to(self.bin / command)
                self.assert_packet_execution(absolute, command)
                relative = self.links / (command + "-relative")
                relative.symlink_to(os.path.relpath(self.bin / command, self.links))
                self.assert_packet_execution(relative, command)
                multi = self.links / (command + "-multi")
                multi.symlink_to(relative.name)
                self.assert_packet_execution(multi, command)
                # PATH invocation and a relative $0 must resolve the same packet.
                env = {**self.env, "PATH": f"{self.links}:{self.env['PATH']}"}
                self.assert_packet_execution(multi.name, command, env=env)
                self.assert_packet_execution(os.path.relpath(multi, self.cwd), command)

    def test_absolute_invocation_with_empty_path(self):
        for command in self.entries:
            self.assert_packet_execution(self.bin / command, command, env={**self.env, "PATH": ""})

    def test_parent_directory_symlink(self):
        alias = self.root / "packet alias"
        alias.symlink_to(self.bin.parent, target_is_directory=True)
        self.assert_packet_execution(alias / "bin/paseo", "paseo")

    def test_wrapper_fails_on_broken_or_cyclic_links(self):
        # Invoke the resolver via sh so the kernel cannot reject the link first.
        for target in ("absent", "loop"):
            link = self.links / target
            link.symlink_to("missing-target" if target == "absent" else target)
            source = runtime.render_wrapper("paseo")
            # Use the rendered script itself, retaining the invoked link as $0.
            result = subprocess.run(["/bin/sh", "-c", source, str(link)], env=self.env,
                                    cwd=self.cwd, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("staged runtime", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_missing_packet_node_or_entrypoint_fails_without_using_path_node(self):
        for missing in (self.bin.parent / "runtime" / self.entries["paseo"], self.bin / "node"):
            with self.subTest(missing=missing.name):
                saved = missing.read_bytes()
                missing.unlink()
                result = self.invoke(self.bin / "paseo")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("staged runtime", result.stderr)
                self.assertEqual(result.stdout, "")
                missing.write_bytes(saved)
                missing.chmod(0o755)

    def test_packager_cli_renders_the_same_wrapper(self):
        for command in self.entries:
            result = subprocess.run([sys.executable, str(Path(runtime.__file__)), command],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, runtime.render_wrapper(command))

    def test_unknown_wrapper_command_is_rejected(self):
        with self.assertRaises(ValueError):
            runtime.render_wrapper("../../other")


if __name__ == "__main__":
    unittest.main()
