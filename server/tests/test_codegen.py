"""Exercise codegen command paths with pnpm's working-directory semantics."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CodegenTests(unittest.TestCase):
    def test_codegen_resolves_inputs_and_outputs_from_the_server_directory(self):
        with tempfile.TemporaryDirectory(prefix="zetacode codegen ") as directory:
            temporary = Path(directory)
            checkout = temporary / "checkout with spaces"
            for relative in (
                "tools",
                "proto",
                "server/src",
                "extension/src/api/generated",
                "extension/node_modules/.bin",
            ):
                (checkout / relative).mkdir(parents=True, exist_ok=True)
            shutil.copyfile(
                ROOT / "tools/generate-proto.sh", checkout / "tools/generate-proto.sh"
            )
            (checkout / "proto/completion.proto").write_text('syntax = "proto3";\n')
            plugin = checkout / "extension/node_modules/.bin/protoc-gen-ts_proto"
            plugin.write_text("#!/bin/sh\nexit 0\n")
            plugin.chmod(0o755)
            binary = temporary / "bin"
            binary.mkdir()
            pnpm = binary / "pnpm"
            pnpm.write_text(f"#!{sys.executable}\n" + textwrap.dedent('''\
                import os
                from pathlib import Path
                import sys

                root = Path(os.environ["CODEGEN_TEST_ROOT"]).resolve()
                args = sys.argv[1:]
                if args[:1] == ["--dir"]:
                    os.chdir(args[1])
                    args = args[2:]
                    assert Path.cwd() == root / "server", Path.cwd()
                    assert args[:4] == ["exec", "python", "-m", "grpc_tools.protoc"], args
                    args = args[4:]
                    include = Path(args[args.index("-I") + 1]).resolve()
                    assert include == root / "proto" and include.is_dir(), include
                    proto = Path(args[-1]).resolve()
                    assert proto == include / "completion.proto" and proto.is_file(), proto
                    options = dict(value.split("=", 1) for value in args if value.startswith("--") and "=" in value)
                    for option in ("--python_out", "--pyi_out", "--grpc_python_out"):
                        output = Path(options[option]).resolve()
                        assert output == root / "server/src" and output.is_dir(), output
                    plugin_name, plugin_path = options["--plugin"].split("=", 1)
                    assert plugin_name == "protoc-gen-ts_proto", plugin_name
                    plugin = Path(plugin_path).resolve()
                    assert plugin == root / "extension/node_modules/.bin/protoc-gen-ts_proto", plugin
                    assert os.access(plugin, os.X_OK), plugin
                    output = Path(options["--ts_proto_out"]).resolve()
                    assert output == root / "extension/src/api/generated" and output.is_dir(), output
                    (output / "completion.ts").write_text("generated fixture\\n")
                else:
                    assert args[:5] == ["--filter", "zetacode", "exec", "vp", "fmt"], args
                    os.chdir(root / "extension")
                    generated = Path(args[5]).resolve()
                    assert generated == root / "extension/src/api/generated/completion.ts", generated
                    assert generated.read_text() == "generated fixture\\n"
                    generated.write_text("formatted fixture\\n")
                '''))
            pnpm.chmod(0o755)
            result = subprocess.run(
                ["/bin/sh", str(checkout / "tools/generate-proto.sh")],
                cwd=temporary,
                env={
                    **os.environ,
                    "PATH": str(binary) + os.pathsep + "/usr/bin:/bin",
                    "CODEGEN_TEST_ROOT": str(checkout),
                },
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(
                (checkout / "extension/src/api/generated/completion.ts").read_text(),
                "formatted fixture\n",
            )


if __name__ == "__main__":
    unittest.main()
