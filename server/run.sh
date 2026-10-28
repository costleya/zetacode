#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MODEL=${ZETA_MODEL:-NexVeridian/zeta-2.1-4bit}
QWEN_MODEL_PATH=${QWEN_MODEL:-mlx-community/Qwen2.5-Coder-7B-Instruct-4bit}
if [ -n "${ZETA_PYTHON:-}" ]; then
  if [ ! -x "$ZETA_PYTHON" ]; then
    echo 'ZETA_PYTHON must name an executable Python with the server dependencies installed.' >&2
    exit 1
  fi
  exec "$ZETA_PYTHON" "$ROOT/src/server.py" --model "$MODEL" --qwen-model "$QWEN_MODEL_PATH" "$@"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo 'Install Node.js 24 and pnpm 12.8.1 or newer, or set ZETA_PYTHON to a prepared Python executable.' >&2
  exit 1
fi
pnpm --dir "$ROOT" install --frozen-lockfile --filter nesweep-zeta-server
exec pnpm --dir "$ROOT" exec python "$ROOT/src/server.py" --model "$MODEL" --qwen-model "$QWEN_MODEL_PATH" "$@"
