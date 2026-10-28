"""Check the shipped helper layout with VSCE's real file selection.

Run from the checkout: python3 extension/test/package-layout.test.py
Requires the repository's existing node_modules; never installs dependencies.
"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class PackageLayoutTests(unittest.TestCase):
    def test_nested_runtime_sources_ship_without_checkout_or_bytecode_artifacts(self):
        included = {
            "server/src/server.py",
            "server/src/decoder.py",
            "server/src/continuation_decoder.py",
            "server/src/setup_progress.py",
            "server/src/completion_pb2.py",
            "server/src/completion_pb2_grpc.py",
            "server/src/unix_grpc_server.py",
            "server/src/nested/future_runtime.py",
            "server/pyproject.toml",
            "server/pylock.toml",
            "server/pnpm-workspace.yaml",
            "server/.python-version",
        }
        excluded = {
            "server/uv.lock",
            "server/run.sh",
            "server/README.md",
            "server/tests/test_server.py",
            "server/benchmarks/benchmark.py",
            "server/outputs/result.json",
            "server/.venv/bin/python",
            "server/weights/model.safetensors",
            "artifacts/result.json",
            "server/src/__pycache__/sentinel.pyc",
            "server/src/__pycache__/accidental.py",
            "server/src/nested/__pycache__/sentinel.pyc",
            "server/src/nested/direct.pyc",
            "server/src/nested/direct.pyo",
        }
        with tempfile.TemporaryDirectory(prefix="nesweep-package-layout-") as directory:
            fixture = Path(directory) / "checkout"
            stage = Path(directory) / "stage"
            (fixture / "extension").mkdir(parents=True)
            for name in ("package.json", ".vscodeignore"):
                shutil.copyfile(ROOT / "extension" / name, fixture / "extension" / name)
            for name in ("README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
                (fixture / name).write_text("package fixture\n")
            for name in included | excluded:
                destination = fixture / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("package fixture\n")
            for name in ("out/extension.mjs", "assets/icon.png"):
                destination = fixture / "extension" / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("package fixture\n")
            staged = subprocess.run(
                ["node", str(ROOT / "tools/stage-extension.mts"), str(fixture), str(stage)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(staged.returncode, 0, staged.stdout + staged.stderr)
            result = subprocess.run(
                [str(ROOT / "extension/node_modules/.bin/vsce"), "ls", "--no-dependencies"],
                cwd=stage, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            packaged = set(result.stdout.splitlines())
            self.assertEqual(included - packaged, set(), "Runtime files missing from VSIX")
            self.assertEqual(excluded & packaged, set(), "Development artifacts leaked into VSIX")
            self.assertEqual(
                {name for name in packaged if name.startswith("server/")},
                included,
            )


if __name__ == "__main__":
    unittest.main()
