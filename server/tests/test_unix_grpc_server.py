"""Private Unix socket ownership for the gRPC server."""

import fcntl
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_server import load_server


server_module = load_server()
PrivateUnixSocket = server_module.PrivateUnixSocket


class UnixGrpcSocketTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="nes-grpc-", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.parent = Path(self.directory.name)
        self.parent.chmod(0o700)
        self.path = self.parent / "completion.sock"

    def service(self):
        return server_module.CompletionService(Mock(), Mock())

    def create_server(self, path: Path | None = None, service: Mock | None = None):
        return server_module.create_server(str(path or self.path), service or self.service())

    def running_server(self, path: Path | None = None):
        server = self.create_server(path)
        server.start()
        self.addCleanup(server.stop, 0)
        return server

    def test_server_socket_parent_socket_and_lifetime_lock_are_private(self):
        server = self.running_server()
        lock_path = Path(str(self.path) + ".lock")
        lock_inode = lock_path.stat().st_ino
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)

        with self.assertRaises((OSError, RuntimeError, ValueError)):
            self.create_server()
        identity = (self.path.stat().st_dev, self.path.stat().st_ino)
        self.assertTrue(stat.S_ISSOCK(self.path.stat().st_mode))
        with self.assertRaises((OSError, RuntimeError, ValueError)):
            self.create_server()
        self.assertEqual(identity, (self.path.stat().st_dev, self.path.stat().st_ino))

        server.stop(0)
        self.assertFalse(self.path.exists())
        self.assertEqual(lock_path.stat().st_ino, lock_inode)
        restarted = self.running_server()
        self.assertEqual(lock_path.stat().st_ino, lock_inode)
        restarted.stop(0)

    def test_shutdown_preserves_replacement_socket_and_releases_lock(self):
        server = self.running_server()
        self.path.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as replacement:
            replacement.bind(str(self.path))
            replacement.listen(1)
            identity = (self.path.stat().st_dev, self.path.stat().st_ino)
            server.stop(0)
            self.assertEqual((self.path.stat().st_dev, self.path.stat().st_ino), identity)
            with open(str(self.path) + ".lock", "rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)

    def test_stale_owned_socket_is_recovered_but_active_socket_is_preserved(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
            stale.bind(str(self.path))
        server = self.running_server()
        self.assertTrue(stat.S_ISSOCK(self.path.stat().st_mode))
        server.stop(0)

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as active:
            active.bind(str(self.path))
            active.listen(1)
            identity = (self.path.stat().st_dev, self.path.stat().st_ino)
            with self.assertRaises((OSError, RuntimeError, ValueError)):
                self.create_server()
            self.assertEqual((self.path.stat().st_dev, self.path.stat().st_ino), identity)

    def test_non_socket_and_symlink_collisions_are_preserved(self):
        target = self.parent / "target"
        target.write_text("preserve")
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                if symlink:
                    self.path.symlink_to(target)
                else:
                    self.path.write_text("preserve")
                with self.assertRaises((OSError, RuntimeError, ValueError)):
                    self.create_server()
                if symlink:
                    self.assertTrue(self.path.is_symlink())
                else:
                    self.assertEqual(self.path.read_text(), "preserve")
                self.path.unlink()

    def test_insecure_parent_and_insecure_lock_are_rejected_without_replacement(self):
        self.parent.chmod(0o755)
        with self.assertRaises((OSError, RuntimeError, ValueError)):
            self.create_server()
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o755)
        self.parent.chmod(0o700)

        lock_path = Path(str(self.path) + ".lock")
        lock_path.write_text("preserve")
        lock_path.chmod(0o644)
        identity = lock_path.stat().st_ino
        with self.assertRaises((OSError, RuntimeError, ValueError)):
            self.create_server()
        self.assertEqual(lock_path.stat().st_ino, identity)
        self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o644)
        self.assertFalse(self.path.exists())

    def test_path_appearing_after_reservation_is_preserved_before_grpc_bind(self):
        owner = PrivateUnixSocket(str(self.path))
        self.addCleanup(owner.close)
        self.path.write_text("do not replace")
        grpc_server = Mock()

        with self.assertRaisesRegex(RuntimeError, "appeared after it was reserved"):
            owner.bind(grpc_server)

        grpc_server.add_insecure_port.assert_not_called()
        self.assertEqual(self.path.read_text(), "do not replace")

    def test_constructor_failure_releases_socket_lock_and_stops_partial_server(self):
        service = Mock(executor=object())
        service.register.side_effect = RuntimeError("registration failed")
        partial_server = Mock()
        lock_path = Path(str(self.path) + ".lock")

        with patch.object(server_module.grpc, "server", return_value=partial_server):
            with self.assertRaisesRegex(RuntimeError, "registration failed"):
                server_module.create_server(str(self.path), service)

        partial_server.stop.assert_called_once_with(0)
        service.shutdown.assert_called_once_with()
        self.assertFalse(self.path.exists())
        with open(lock_path, "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)

    def test_start_failure_stops_server_and_releases_socket_lock(self):
        service = Mock(executor=object())
        service.register.return_value = None
        server = server_module.create_server(str(self.path), service)
        server._server.add_insecure_port = Mock(return_value=0)
        server._server.stop = Mock(return_value=Mock())
        lock_path = Path(str(self.path) + ".lock")

        with self.assertRaisesRegex(RuntimeError, "gRPC could not bind"):
            server.start()

        server._server.stop.assert_called_once_with(0)
        service.shutdown.assert_called_once_with()
        self.assertFalse(self.path.exists())
        with open(lock_path, "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == "__main__":
    unittest.main()
