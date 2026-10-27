"""gRPC over a private Unix socket with lifetime ownership locking."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Protocol, Self

if TYPE_CHECKING:
    import grpc

import errno
import fcntl
import os
import socket
import stat
import tempfile


class CompletionServiceLifecycle(Protocol):
    executor: ThreadPoolExecutor

    def register(self, grpc_server: grpc.Server) -> None: ...
    def shutdown(self) -> None: ...


QuarantinedSocket = tuple[str, tuple[int, int]]


def validate_socket_path(path: object) -> str:
    if not isinstance(path, str) or not os.path.isabs(path) or '\0' in path or len(os.fsencode(path)) > 103:
        raise ValueError('socket path must be absolute and at most 103 encoded bytes')
    return path


class PrivateUnixSocket:
    """Own and secure a Unix socket path before gRPC is allowed to bind it."""

    def __init__(self, socket_path: str) -> None:
        self.socket_path = validate_socket_path(socket_path)
        self._lock_fd: int | None = None
        self._bound_identity: tuple[int, int] | None = None
        self._closed = False
        try:
            self._acquire_lock()
            self._remove_stale_socket()
        except BaseException:
            self.close()
            raise

    def _acquire_lock(self) -> None:
        parent = os.path.dirname(self.socket_path)
        try:
            os.mkdir(parent, 0o700)
        except FileExistsError:
            pass
        directory = os.lstat(parent)
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid()
                or stat.S_IMODE(directory.st_mode) != 0o700):
            raise ValueError('socket parent must be an owned private directory with mode 0700')
        lock_path = self.socket_path + '.lock'
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        self._lock_fd = fd
        lock = os.fstat(fd)
        entry = os.lstat(lock_path)
        if (not stat.S_ISREG(lock.st_mode) or lock.st_uid != os.getuid()
                or stat.S_IMODE(lock.st_mode) != 0o600 or lock.st_nlink != 1
                or (entry.st_dev, entry.st_ino) != (lock.st_dev, lock.st_ino)):
            raise ValueError('socket lock must be an owned regular file with mode 0600')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another server owns this socket lock') from error

    def _remove_stale_socket(self) -> None:
        try:
            entry = os.lstat(self.socket_path)
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
            raise ValueError('refusing to replace a socket path not owned by this server user')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.2)
            try:
                probe.connect(self.socket_path)
            except OSError as error:
                if error.errno != errno.ECONNREFUSED:
                    raise RuntimeError('cannot establish that the existing socket is stale') from error
            else:
                raise RuntimeError('another server is listening on this socket')
        current = os.lstat(self.socket_path)
        if (current.st_dev, current.st_ino) != (entry.st_dev, entry.st_ino):
            raise RuntimeError('socket path changed while checking ownership')
        os.unlink(self.socket_path)

    def bind(self, grpc_server: grpc.Server) -> None:
        if self._closed:
            raise RuntimeError('socket ownership has already been released')
        if self._bound_identity is not None:
            raise RuntimeError('socket is already bound')
        try:
            os.lstat(self.socket_path)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError('socket path appeared after it was reserved')
        if not grpc_server.add_insecure_port('unix:' + self.socket_path):
            raise RuntimeError('gRPC could not bind the Unix socket')
        entry = os.lstat(self.socket_path)
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
            raise RuntimeError('gRPC did not create an owned Unix socket')
        self._bound_identity = (entry.st_dev, entry.st_ino)
        os.chmod(self.socket_path, 0o600)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._bound_identity is not None:
                try:
                    entry = os.lstat(self.socket_path)
                except FileNotFoundError:
                    pass
                else:
                    if (stat.S_ISSOCK(entry.st_mode) and entry.st_uid == os.getuid()
                            and (entry.st_dev, entry.st_ino) == self._bound_identity):
                        os.unlink(self.socket_path)
                self._bound_identity = None
        finally:
            if self._lock_fd is not None:
                os.close(self._lock_fd)
                self._lock_fd = None

    def quarantine_for_grpc_shutdown(self) -> QuarantinedSocket | None:
        """Move any current path entry aside so gRPC cannot unlink a replacement."""
        if self._bound_identity is None:
            return None
        try:
            os.lstat(self.socket_path)
        except FileNotFoundError:
            return None
        descriptor, quarantine_path = tempfile.mkstemp(
            prefix='.grpc-shutdown-', dir=os.path.dirname(self.socket_path))
        os.close(descriptor)
        try:
            os.replace(self.socket_path, quarantine_path)
        except FileNotFoundError:
            os.unlink(quarantine_path)
            return None
        entry = os.lstat(quarantine_path)
        return quarantine_path, (entry.st_dev, entry.st_ino)

    def restore_after_grpc_shutdown(self, quarantined: QuarantinedSocket | None) -> None:
        if quarantined is None:
            return
        quarantine_path, identity = quarantined
        try:
            entry = os.lstat(quarantine_path)
        except FileNotFoundError:
            return
        if (entry.st_dev, entry.st_ino) != identity:
            raise RuntimeError('quarantined socket path changed during gRPC shutdown')
        if identity == self._bound_identity:
            os.unlink(quarantine_path)
            return
        try:
            os.link(quarantine_path, self.socket_path, follow_symlinks=False)
        except OSError as error:
            raise RuntimeError('could not restore the unrelated socket path without replacing '
                               f'an entry; preserved it at {quarantine_path}') from error
        restored = os.lstat(self.socket_path)
        if (restored.st_dev, restored.st_ino) != identity:
            raise RuntimeError('socket path was replaced again while gRPC was shutting down; '
                               f'preserved the entry at {quarantine_path}')
        os.unlink(quarantine_path)


class GrpcUnixServer:
    """Manage gRPC startup, cooperative cancellation, and socket ownership."""

    def __init__(self, socket_path: str, service: CompletionServiceLifecycle,
                 socket_owner: PrivateUnixSocket | None = None) -> None:
        self.service = service
        self._socket_owner: PrivateUnixSocket | None = socket_owner
        self._server: grpc.Server | None = None
        try:
            self._socket_owner = self._socket_owner or PrivateUnixSocket(socket_path)
            if self._socket_owner.socket_path != validate_socket_path(socket_path):
                raise ValueError('socket reservation does not match the requested path')
            import grpc

            self._server = grpc.server(service.executor, options=(
                ('grpc.max_receive_message_length', 8 * 1024 * 1024),
                ('grpc.max_send_message_length', 8 * 1024 * 1024)))
            service.register(self._server)
        except BaseException:
            if self._server is not None:
                try:
                    self._server.stop(0).wait()
                except BaseException:
                    pass
            try:
                service.shutdown()
            except BaseException:
                pass
            if self._socket_owner is not None:
                try:
                    self._socket_owner.close()
                except BaseException:
                    pass
            raise
        assert self._server is not None and self._socket_owner is not None
        self._started = False
        self._stopped = False

    def start(self) -> Self:
        assert self._server is not None and self._socket_owner is not None
        if self._started or self._stopped:
            raise RuntimeError('gRPC server cannot be started in its current state')
        try:
            self._socket_owner.bind(self._server)
            self._server.start()
            self._started = True
        except BaseException:
            try:
                self.stop(grace=0)
            except BaseException:
                pass
            raise
        return self

    def stop(self, grace: float | None = None) -> None:
        assert self._server is not None and self._socket_owner is not None
        if self._stopped:
            return
        stopped = None
        quarantined = None
        quarantine_error = None
        try:
            quarantined = self._socket_owner.quarantine_for_grpc_shutdown()
        except BaseException as error:
            quarantine_error = error
        self._stopped = True
        try:
            try:
                stopped = self._server.stop(grace)
            finally:
                try:
                    self.service.shutdown()
                finally:
                    if stopped is not None:
                        stopped.wait()
        finally:
            try:
                self._socket_owner.restore_after_grpc_shutdown(quarantined)
            finally:
                self._socket_owner.close()
        if quarantine_error is not None:
            raise quarantine_error

    def wait_for_termination(self, timeout: float | None = None) -> bool:
        assert self._server is not None
        return self._server.wait_for_termination(timeout=timeout)


def create_server(socket_path: str, service: CompletionServiceLifecycle,
                  socket_owner: PrivateUnixSocket | None = None) -> GrpcUnixServer:
    return GrpcUnixServer(socket_path, service, socket_owner=socket_owner)
