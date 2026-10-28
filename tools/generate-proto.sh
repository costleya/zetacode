#!/bin/sh
# Run from any directory after pnpm install. Generated bindings are committed.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
pnpm --dir "$ROOT/server" exec python -m grpc_tools.protoc \
  -I "$ROOT/proto" \
  --python_out="$ROOT/server/src" \
  --pyi_out="$ROOT/server/src" \
  --grpc_python_out="$ROOT/server/src" \
  --plugin="protoc-gen-ts_proto=$ROOT/extension/node_modules/.bin/protoc-gen-ts_proto" \
  --ts_proto_out="$ROOT/extension/src/api/generated" \
  --ts_proto_opt=outputServices=grpc-js,env=node,esModuleInterop=true,useOptionals=messages,oneof=unions-value,forceLong=number \
  "$ROOT/proto/completion.proto"
pnpm --filter zetacode exec vp fmt src/api/generated/completion.ts
