"""Startup telemetry contracts without network access or model dependencies."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from typing import Protocol, cast
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    'setup_progress_contract', Path(__file__).resolve().parents[1] / "src" / 'setup_progress.py')
assert spec is not None and spec.loader is not None
progress_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress_module)
SETUP_ID = '67ff8c7c-8ab2-4cec-8d5c-a491bc888038'


class TestProgressBar(Protocol):
    n: int | float
    total: int | float | None

    def update(self, n: int | float | None = 1) -> None: ...
    def refresh(self) -> None: ...
    def close(self) -> None: ...


class QuietTqdm:
    """Minimal public tqdm counter API; disabled bars do not update themselves."""

    def __init__(self, *args: object, total: int | float | None = None,
                 initial: int = 0, **kwargs: object) -> None:
        self.n = initial
        self.total = total

    def close(self) -> None:
        pass


class SetupProgressTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.status_file = self.directory / 'setup-status.json'
        self.progress = progress_module.SetupProgress(self.status_file, SETUP_ID)
        self.addCleanup(self.progress.close)
        self.clock = 100.0
        self.addCleanup(patch.stopall)
        patch.object(progress_module.time, 'monotonic', side_effect=lambda: self.clock).start()
        patch.object(progress_module.time, 'time', side_effect=lambda: self.clock + 1_800_000_000).start()
        tqdm_module = types.ModuleType('huggingface_hub.utils.tqdm')
        setattr(tqdm_module, 'tqdm', QuietTqdm)
        patch.dict(sys.modules, {'huggingface_hub.utils.tqdm': tqdm_module}).start()
        self.progress.stage('resolving', 'Zeta', 1)

    def read(self):
        return json.loads(self.status_file.read_text())

    def bar(self, kind: str = 'transfer', **options: object) -> TestProgressBar:
        name = 'huggingface_hub.snapshot_download'
        if kind == 'transfer':
            name += '.transfer'
        return cast(TestProgressBar,
                    self.progress.tqdm_class()(name=name, unit='B', **options))

    def flush(self):
        self.clock += 2
        self.progress.close()
        return self.read()

    def test_atomic_private_json_replaces_old_status_and_leaves_no_temporary_files(self):
        previous = self.status_file.read_text()
        replace = progress_module.os.replace

        def observe_replace(source: str, destination: str | Path) -> None:
            self.assertEqual(self.status_file.read_text(), previous)
            pending = json.loads(Path(source).read_text())
            self.assertEqual(pending['stage'], 'loading')
            self.assertEqual(Path(source).stat().st_mode & 0o777, 0o600)
            replace(source, destination)

        with patch.object(progress_module.os, 'replace', side_effect=observe_replace) as atomic:
            self.progress.stage('loading', 'Qwen', 2)
        atomic.assert_called_once()
        value = self.read()
        self.assertEqual(value, {
            'schema_version': 1, 'setup_id': SETUP_ID, 'stage': 'loading',
            'model': 'Qwen', 'model_index': 2, 'model_count': 2,
            'updated_at': self.clock + 1_800_000_000,
        })
        self.assertEqual(list(self.directory.iterdir()), [self.status_file])

    def test_write_failure_keeps_prior_complete_status_and_does_not_fail_model_setup(self):
        previous = self.status_file.read_text()
        with patch.object(progress_module.os, 'replace', side_effect=OSError('disk full')):
            self.progress.stage('loading', 'Zeta', 1)
        self.assertEqual(self.status_file.read_text(), previous)
        self.assertEqual(list(self.directory.iterdir()), [self.status_file])

    def test_cache_hit_has_no_invented_bytes_speed_or_eta(self):
        self.progress.stage('loading', 'Zeta', 1)
        value = self.read()
        self.assertFalse(set(value) & {
            'downloaded_bytes', 'total_bytes', 'speed_bytes_per_second', 'eta_seconds',
            'total_bytes_estimated', 'reconstructed_bytes', 'reconstruction_total_bytes'})

    def test_resume_counts_absolute_bytes_once_and_measures_only_new_transfer(self):
        transfer = self.bar(initial=100, total=1000)
        self.clock += 2
        transfer.update(100)
        transfer.refresh()
        transfer.close()
        value = self.read()
        self.assertEqual(value['downloaded_bytes'], 200)
        self.assertEqual(value['speed_bytes_per_second'], 50)
        self.assertEqual(value['total_bytes'], 1000)
        self.assertIs(value['total_bytes_estimated'], True)
        self.assertNotIn('eta_seconds', value)

    def test_file_count_and_reconstruction_do_not_double_count_network_bytes(self):
        transfer = self.bar(total=1000)
        saved = self.bar('reconstruction', total=2000)
        file_count = self.progress.tqdm_class()(
            name='huggingface_hub.snapshot_download', unit='it', total=3)
        transfer.update(100)
        saved.update(500)
        file_count.update(2)
        value = self.flush()
        self.assertEqual(value['downloaded_bytes'], 100)
        self.assertEqual(value['reconstructed_bytes'], 500)
        self.assertEqual(value['reconstruction_total_bytes'], 2000)
        self.assertEqual(value['total_bytes'], 1000)
        self.assertIs(value['total_bytes_estimated'], True)

    def test_transfer_total_changes_are_estimates_and_do_not_change_actual_count_or_rate(self):
        transfer = self.bar(initial=100, total=1000)
        self.clock += 2
        transfer.update(100)
        transfer.total = 2000
        self.clock += 2
        transfer.refresh()
        value = self.read()
        self.assertEqual(value['downloaded_bytes'], 200)
        self.assertEqual(value['total_bytes'], 2000)
        self.assertIs(value['total_bytes_estimated'], True)
        self.assertEqual(value['speed_bytes_per_second'], 50)
        self.assertNotIn('eta_seconds', value)

    def test_unknown_zero_or_invalid_transfer_total_clears_previous_estimate(self):
        transfer = self.bar(initial=100, total=1000)
        for total in (None, 0, -1, float('nan'), float('inf'), True):
            with self.subTest(total=total):
                transfer.total = 1000
                self.clock += 2
                transfer.refresh()
                self.assertEqual(self.read()['total_bytes'], 1000)
                transfer.total = total
                self.clock += 2
                transfer.refresh()
                value = self.read()
                self.assertEqual(value['downloaded_bytes'], 100)
                self.assertNotIn('total_bytes', value)
                self.assertNotIn('total_bytes_estimated', value)

    def test_failed_bar_close_keeps_actual_count_and_never_declares_setup_complete(self):
        transfer = self.bar(initial=100, total=1000)
        self.clock += 2
        transfer.update(100)
        # HF may snap its estimated denominator to bytes transferred when a bar
        # closes after a failure. Reaching that estimate is not load readiness.
        transfer.total = transfer.n
        self.clock += 2
        transfer.close()
        value = self.read()
        self.assertEqual(value['downloaded_bytes'], 200)
        self.assertEqual(value['total_bytes'], 200)
        self.assertIs(value['total_bytes_estimated'], True)
        self.assertEqual(value['stage'], 'downloading')
        self.assertNotIn('download_complete', value)
        self.progress.error(RuntimeError('download failed'))
        self.assertEqual(self.read()['stage'], 'error')

    def test_successful_load_transition_clears_download_estimates(self):
        transfer = self.bar(initial=100, total=100)
        transfer.close()
        self.progress.stage('loading', 'Zeta', 1)
        value = self.read()
        self.assertEqual(value['stage'], 'loading')
        self.assertFalse(set(value) & {'downloaded_bytes', 'total_bytes',
                                      'total_bytes_estimated', 'speed_bytes_per_second'})

    def test_concurrent_callbacks_on_aggregate_bar_preserve_every_network_byte(self):
        transfer = self.bar(total=4000)

        def worker():
            for _ in range(100):
                transfer.update(10)

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(worker) for _ in range(4)]
            for future in futures:
                future.result()
        self.assertEqual(self.flush()['downloaded_bytes'], 4000)

    def test_retry_rollback_clears_stale_rate_and_never_reports_negative_bytes(self):
        transfer = self.bar(initial=100, total=1000)
        self.clock += 2
        transfer.update(100)
        self.assertIn('speed_bytes_per_second', self.read())
        self.clock += 2
        transfer.update(-250)
        value = self.read()
        self.assertEqual(value['downloaded_bytes'], 0)
        self.assertNotIn('speed_bytes_per_second', value)
        self.assertNotIn('eta_seconds', value)

    def test_saved_bytes_are_bounded_and_unknown_totals_do_not_create_percentage_inputs(self):
        saved = self.bar('reconstruction', total=100)
        saved.update(150)
        self.assertEqual(self.flush()['reconstructed_bytes'], 100)
        saved.total = None
        saved.update(10)
        value = self.flush()
        self.assertEqual(value['reconstructed_bytes'], 160)
        self.assertNotIn('reconstruction_total_bytes', value)

    def test_heartbeat_refreshes_loading_and_removes_stalled_transfer_rate(self):
        transfer = self.bar(initial=100)
        self.clock += 2
        transfer.update(100)
        self.assertIn('speed_bytes_per_second', self.read())
        self.clock += 6
        with patch.object(self.progress._stop, 'wait', side_effect=[False, True]):
            self.progress._heartbeat()
        self.assertNotIn('speed_bytes_per_second', self.read())
        self.progress.stage('loading', 'Qwen', 2)
        self.clock += 5
        with patch.object(self.progress._stop, 'wait', side_effect=[False, True]):
            self.progress._heartbeat()
        self.assertEqual(self.read()['updated_at'], self.clock + 1_800_000_000)
        self.assertEqual(self.read()['stage'], 'loading')

    def test_failure_status_does_not_expose_urls_tokens_or_exception_text(self):
        self.progress.error(RuntimeError('https://user:secret@example/model?token=private'))
        value = self.read()
        self.assertEqual(value['stage'], 'error')
        self.assertIn('RuntimeError', value['message'])
        self.assertLessEqual(len(value['message']), 300)
        self.assertNotRegex(json.dumps(value), r'https|secret|private|token|example')


class ResolveModelTests(unittest.TestCase):
    def test_local_model_path_skips_hub_import_and_download(self):
        with tempfile.TemporaryDirectory() as model:
            progress = Mock()
            with patch.dict(sys.modules, {'huggingface_hub': None, 'mlx_lm.utils': None}):
                self.assertEqual(progress_module.resolve_model(model, progress), model)
            progress.tqdm_class.assert_not_called()

    def test_remote_model_passes_callback_only_to_explicit_snapshot_call(self):
        hub = types.ModuleType('huggingface_hub')
        snapshot_download = Mock(return_value='/cache/snapshot')
        setattr(hub, 'snapshot_download', snapshot_download)
        utils = types.ModuleType('mlx_lm.utils')
        allow_patterns = ['*.safetensors', '*.json']
        setattr(utils, 'DEFAULT_ALLOW_PATTERNS', allow_patterns)
        progress = Mock()
        with patch.dict(sys.modules, {'huggingface_hub': hub, 'mlx_lm.utils': utils}), \
                patch.dict(os.environ, {'MLXLM_USE_MODELSCOPE': ''}):
            original = snapshot_download
            result = progress_module.resolve_model('org/model', progress)
            self.assertIs(getattr(hub, 'snapshot_download'), original)
        self.assertEqual(result, '/cache/snapshot')
        snapshot_download.assert_called_once_with(
            'org/model', allow_patterns=allow_patterns,
            tqdm_class=progress.tqdm_class.return_value)


if __name__ == '__main__':
    unittest.main()
