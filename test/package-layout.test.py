"""Check the shipped helper layout with VSCE's real file selection.

Run from the checkout: python3 test/package-layout.test.py
Requires the repository's existing node_modules; never installs dependencies.
"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PackageLayoutTests(unittest.TestCase):
    def test_nested_runtime_sources_ship_without_checkout_or_bytecode_artifacts(self):
        included = {
            "tools/zeta-server/src/server.py",
            "tools/zeta-server/src/decoder.py",
            "tools/zeta-server/src/continuation_decoder.py",
            "tools/zeta-server/src/setup_progress.py",
            "tools/zeta-server/src/proto/completion.proto",
            "tools/zeta-server/src/completion_pb2.py",
            "tools/zeta-server/src/completion_pb2_grpc.py",
            "tools/zeta-server/src/unix_grpc_server.py",
            "tools/zeta-server/src/nested/future_runtime.py",
            "tools/zeta-server/pyproject.toml",
            "tools/zeta-server/uv.lock",
            "tools/zeta-server/.python-version",
        }
        excluded = {
            "tools/zeta-server/run.sh",
            "tools/zeta-server/README.md",
            "tools/zeta-server/tests/test_server.py",
            "tools/zeta-server/benchmarks/benchmark.py",
            "tools/zeta-server/outputs/result.json",
            "tools/zeta-server/.venv/bin/python",
            "tools/zeta-server/weights/model.safetensors",
            "outputs/result.json",
            "tools/zeta-server/src/__pycache__/sentinel.pyc",
            "tools/zeta-server/src/__pycache__/accidental.py",
            "tools/zeta-server/src/nested/__pycache__/sentinel.pyc",
            "tools/zeta-server/src/nested/direct.pyc",
            "tools/zeta-server/src/nested/direct.pyo",
        }
        with tempfile.TemporaryDirectory(prefix="nesweep-package-layout-") as directory:
            fixture = Path(directory)
            # Copy the actual packaging rules and manifest; fixtures are never
            # written into the checkout's runtime source or packaged output.
            for name in ("package.json", ".vscodeignore"):
                shutil.copyfile(ROOT / name, fixture / name)
            for name in included | excluded | {"out/extension.mjs", "README.md"}:
                destination = fixture / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("package fixture\n")
            result = subprocess.run(
                [str(ROOT / "node_modules/.bin/vsce"), "ls", "--no-dependencies"],
                cwd=fixture, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            packaged = set(result.stdout.splitlines())
            self.assertEqual(included - packaged, set(), "Runtime files missing from VSIX")
            self.assertEqual(excluded & packaged, set(), "Development artifacts leaked into VSIX")
            self.assertEqual(
                {name for name in packaged if name.startswith("tools/zeta-server/")},
                included,
            )


if __name__ == "__main__":
    unittest.main()
