#!/bin/sh
# Run from any directory after pnpm install. Generated bindings are committed.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"
uv run --locked --group codegen --project tools/zeta-server python -m grpc_tools.protoc \
  -I tools/zeta-server/src/proto \
  --python_out=tools/zeta-server/src \
  --pyi_out=tools/zeta-server/src \
  --grpc_python_out=tools/zeta-server/src \
  --plugin=protoc-gen-ts_proto=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=src/api/generated \
  --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,useOptionals=messages,oneof=unions-value,forceLong=number \
  tools/zeta-server/src/proto/completion.proto
pnpm exec vp fmt src/api/generated/completion.ts
