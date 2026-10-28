"""Launcher contracts using executable stubs; no MLX runtime or downloads needed."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOCKET_PATH = "/tmp/nesweep-test/server.sock"


class LauncherTests(unittest.TestCase):
    def run_launcher(self, *, overrides: dict[str, str] | None = None, runtime_override: bool = False, arguments: list[str] | None = None) -> list[str]:
        with tempfile.TemporaryDirectory(prefix="zeta launcher ") as directory:
            temporary = Path(directory)
            capture = temporary / "arguments"
            runtime = temporary / ("custom python" if runtime_override else "pnpm")
            runtime.write_text('#!/bin/sh\ncase " $* " in *" install "*) printf \'%s\\n\' "$@" > "$ZETA_TEST_INSTALL";; *) printf \'%s\\n\' "$@" > "$ZETA_TEST_ARGUMENTS";; esac\n')
            runtime.chmod(0o755)
            environment = {
                "PATH": str(temporary) + os.pathsep + "/usr/bin:/bin",
                "HOME": str(temporary / "empty home"),
                "ZETA_TEST_ARGUMENTS": str(capture),
                "ZETA_TEST_INSTALL": str(temporary / "install"),
            }
            if runtime_override:
                environment["ZETA_PYTHON"] = str(runtime)
            environment.update(overrides or {})
            result = subprocess.run(
                ["/bin/sh", str(ROOT / "run.sh"), *(arguments if arguments is not None else ["--socket-path", SOCKET_PATH])],
                env=environment, cwd=temporary, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            if not runtime_override:
                self.assertEqual((temporary / "install").read_text().splitlines(), [
                    "--dir", str(ROOT), "install", "--frozen-lockfile",
                    "--filter", "nesweep-zeta-server",
                ])
            else:
                self.assertFalse((temporary / "install").exists(), "ZETA_PYTHON must bypass pnpm")
            return capture.read_text().splitlines()

    def test_default_launcher_uses_managed_project_and_both_hugging_face_models(self):
        arguments = self.run_launcher()
        self.assertEqual(arguments[:4], ["--dir", str(ROOT), "exec", "python"])
        script_index = arguments.index(str(ROOT / "src" / "server.py"))
        self.assertEqual(arguments[script_index + 1:], [
            "--model", "NexVeridian/zeta-2.1-4bit",
            "--qwen-model", "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
            "--socket-path", SOCKET_PATH])
        self.assertNotIn("--upstream", arguments)
        self.assertFalse(any(".lmstudio" in value for value in arguments))

    def test_launcher_preserves_socket_path_with_spaces(self):
        arguments = self.run_launcher(arguments=["--socket-path", "/tmp/nesweep-test/custom socket.sock"])
        script_index = arguments.index(str(ROOT / "src" / "server.py"))
        self.assertEqual(arguments[script_index + 1:], [
            "--model", "NexVeridian/zeta-2.1-4bit",
            "--qwen-model", "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
            "--socket-path", "/tmp/nesweep-test/custom socket.sock"])
        self.assertNotIn("--port", arguments)

    def test_python_and_both_model_overrides_preserve_paths_with_spaces(self):
        arguments = self.run_launcher(
            runtime_override=True, overrides={
                "ZETA_MODEL": "/models/zeta weights",
                "QWEN_MODEL": "/models/qwen weights",
            })
        self.assertEqual(arguments, [str(ROOT / "src" / "server.py"),
                                   "--model", "/models/zeta weights",
                                   "--qwen-model", "/models/qwen weights",
                                   "--socket-path", SOCKET_PATH])

    def test_managed_runtime_keeps_zeta_override_and_default_qwen_model(self):
        arguments = self.run_launcher(overrides={"ZETA_MODEL": "organization/custom-model"})
        model_index = arguments.index("--model")
        self.assertEqual(arguments[model_index + 1], "organization/custom-model")
        qwen_model_index = arguments.index("--qwen-model")
        self.assertEqual(arguments[qwen_model_index + 1],
                         "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")

    def test_managed_runtime_keeps_qwen_override_and_default_zeta_model(self):
        arguments = self.run_launcher(overrides={"QWEN_MODEL": "organization/custom-qwen"})
        model_index = arguments.index("--model")
        self.assertEqual(arguments[model_index + 1], "NexVeridian/zeta-2.1-4bit")
        qwen_model_index = arguments.index("--qwen-model")
        self.assertEqual(arguments[qwen_model_index + 1], "organization/custom-qwen")


if __name__ == "__main__":
    unittest.main()
