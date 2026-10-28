"""Private startup status; callbacks observe downloads without touching MLX state."""
from collections import deque
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from typing import Protocol, TypeAlias, cast


Numeric: TypeAlias = int | float
StateValue: TypeAlias = str | int | float | bool | None


class _ProgressBar(Protocol):
    n: float
    total: float | None

    def __init__(self, *args: object, **kwargs: object) -> None: ...
    def update(self, n: float | None = 1) -> None: ...
    def refresh(self, *args: object, **kwargs: object) -> None: ...
    def close(self) -> None: ...


class _SnapshotDownload(Protocol):
    def __call__(self, repo_id: str, *, allow_patterns: list[str] | str | None = None,
                 tqdm_class: type[_ProgressBar] | None = None) -> str: ...


class _HuggingFaceHub(Protocol):
    snapshot_download: _SnapshotDownload


def _nonnegative(value: object) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


class SetupProgress:
    def __init__(self, status_file: str | os.PathLike[str] | None = None,
                 setup_id: str | None = None) -> None:
        self.status_file = Path(status_file) if status_file else None
        self.setup_id = setup_id
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._state: dict[str, StateValue] = {}
        self._last_write = float('-inf')
        self._samples: deque[tuple[float, Numeric]] = deque()
        self._thread: threading.Thread | None = None
        if self.status_file:
            self._thread = threading.Thread(target=self._heartbeat, daemon=True,
                                            name='nes-setup-status')
            self._thread.start()

    def stage(self, stage: str, model: str | None = None,
              model_index: int | None = None) -> None:
        with self._lock:
            self._state = {'stage': stage}
            if model is not None:
                self._state.update(model=model, model_index=model_index, model_count=2)
            self._samples.clear()
            self._write(force=True)

    def error(self, error: BaseException) -> None:
        # Exception text can contain authenticated URLs or tokens. The log retains
        # the traceback; the shared status needs only a bounded failure category.
        with self._lock:
            category = type(error).__name__
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', category):
                category = 'Error'
            self._state = {'stage': 'error', 'message':
                           'Model setup failed (' + category + ')'}
            self._samples.clear()
            self._write(force=True)

    def _heartbeat(self) -> None:
        while not self._stop.wait(5):
            with self._lock:
                self._write(force=True)

    def _write(self, force: bool = False) -> None:
        if not self.status_file or not self._state:
            return
        now = time.monotonic()
        if not force and now - self._last_write < 1:
            return
        data: dict[str, StateValue] = dict(schema_version=1, setup_id=self.setup_id,
                                          **self._state,
                                          updated_at=time.time())
        # A stalled transfer must not keep displaying its previous speed or ETA.
        if self._samples and now - self._samples[-1][0] < 5:
            first_time, first_bytes = self._samples[0]
            last_time, last_bytes = self._samples[-1]
            elapsed = last_time - first_time
            if elapsed > 0 and last_bytes > first_bytes:
                rate = (last_bytes - first_bytes) / elapsed
                if _nonnegative(rate):
                    data['speed_bytes_per_second'] = rate
        temporary: str | None = None
        try:
            descriptor, temporary = tempfile.mkstemp(
                prefix='.' + self.status_file.name + '.', dir=self.status_file.parent)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(data, stream, allow_nan=False, separators=(',', ':'))
            os.replace(temporary, self.status_file)
            self._last_write = now
        except OSError:
            # UI telemetry cannot turn a successful model load into a failure.
            pass
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def _observe(self, kind: str, count: Numeric, total: Numeric | None) -> None:
        with self._lock:
            if self._state.get('stage') not in ('resolving', 'downloading'):
                return
            self._state['stage'] = 'downloading'
            count = max(0, count) if math.isfinite(count) else 0
            if kind == 'transfer':
                previous_value = self._state.get('downloaded_bytes', 0)
                previous = previous_value if isinstance(previous_value, (int, float)) else 0
                self._state['downloaded_bytes'] = count
                # HF seeds this denominator with model-file sizes and can grow
                # it heuristically for Xet compression/deduplication. It is an
                # estimate, not a network byte total or a basis for an ETA.
                if total is not None and _nonnegative(total) and total > 0:
                    self._state['total_bytes'] = total
                    self._state['total_bytes_estimated'] = True
                else:
                    self._state.pop('total_bytes', None)
                    self._state.pop('total_bytes_estimated', None)
                if count < previous:
                    self._samples.clear()
                if count != previous:
                    now = time.monotonic()
                    self._samples.append((now, count))
                    while len(self._samples) > 2 and now - self._samples[0][0] > 10:
                        self._samples.popleft()
            else:
                if total is not None and _nonnegative(total) and total > 0:
                    self._state['reconstructed_bytes'] = min(count, total)
                    self._state['reconstruction_total_bytes'] = total
                else:
                    self._state['reconstructed_bytes'] = count
                    self._state.pop('reconstruction_total_bytes', None)
            self._write()

    def tqdm_class(self) -> type[_ProgressBar]:
        from huggingface_hub.utils.tqdm import tqdm
        if self.status_file is None:
            # Hugging Face exposes an untyped tqdm class in this environment.
            return cast(type[_ProgressBar], tqdm)
        progress = self
        class DownloadProgress(tqdm):
            def __init__(self, *args: object, **kwargs: object) -> None:
                name = kwargs.get('name')
                self._progress_kind: str | None = None
                if kwargs.get('unit') == 'B':
                    if name == 'huggingface_hub.snapshot_download.transfer':
                        self._progress_kind = 'transfer'
                    elif name == 'huggingface_hub.snapshot_download':
                        self._progress_kind = 'reconstruction'
                # Keep the normal tqdm lock/context/iteration API for HF's file
                # worker pool, but avoid terminal rendering. We maintain n even
                # when HF_HUB_DISABLE_PROGRESS_BARS disables tqdm's own updates.
                kwargs['disable'] = True
                cast(_ProgressBar, super()).__init__(*args, **kwargs)
                self.refresh()

            def update(self, n: Numeric | None = 1) -> None:
                with progress._lock:
                    self.n += n or 0
                    self.refresh()

            def refresh(self, *args: object, **kwargs: object) -> None:
                if self._progress_kind is not None and hasattr(self, 'n'):
                    progress._observe(self._progress_kind, self.n, self.total)

            def close(self) -> None:
                self.refresh()
                cast(_ProgressBar, super()).close()

        return cast(type[_ProgressBar], DownloadProgress)

    def close(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join()
        with self._lock:
            self._write(force=True)


def resolve_model(model: str, progress: SetupProgress) -> str:
    """Match mlx_lm's normal file selection, then load that exact local snapshot."""
    if Path(model).exists():
        return model
    import huggingface_hub
    from mlx_lm.utils import DEFAULT_ALLOW_PATTERNS
    if os.environ.get('MLXLM_USE_MODELSCOPE', '').lower() == 'true':
        # Preserve MLX's alternative backend and its existing download behavior.
        return model
    # snapshot_download's installed overload leaves its tqdm class generic unknown.
    download = cast(_HuggingFaceHub, huggingface_hub).snapshot_download
    return download(model, allow_patterns=DEFAULT_ALLOW_PATTERNS,
                    tqdm_class=progress.tqdm_class())
