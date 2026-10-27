import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  Server,
  ServerCredentials,
  type ServerWritableStream,
  type sendUnaryData,
  type ServerUnaryCall,
} from "@grpc/grpc-js";
import {
  CompletionServiceService,
  type CompletionRequest,
  type CompletionEvent,
  type HealthRequest,
  type HealthResponse,
} from "../../src/api/generated/completion.ts";

export type CompletionCall = ServerWritableStream<CompletionRequest, CompletionEvent>;
export const dualModels = ["zeta-2.1", "qwen2.5-coder-7b-instruct"];
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
export async function grpcServer(
  complete: (call: CompletionCall) => void,
  health: (
    call: ServerUnaryCall<HealthRequest, HealthResponse>,
    callback: sendUnaryData<HealthResponse>,
  ) => void = (_call, callback) => callback(null, { ready: true, models: dualModels }),
) {
  const directory = await mkdtemp("/tmp/nes-grpc-test-");
  const socketPath = join(directory, "grpc.sock");
  const server = new Server();
  server.addService(CompletionServiceService, { complete, health });
  await new Promise<void>((resolve, reject) =>
    server.bindAsync(`unix:${socketPath}`, ServerCredentials.createInsecure(), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  return {
    endpoint: { socketPath },
    close: async () => {
      server.forceShutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export function final(
  call: CompletionCall,
  text = "complete output",
  finishReason = "stop",
  usage?: { promptEvalCount: number; evalCount: number },
) {
  call.write({ event: { $case: "finalResult", value: { text, finishReason, ...usage } } });
  call.end();
}
export function firstToken(call: CompletionCall) {
  call.write({ event: { $case: "firstToken", value: {} } });
}
export function noEditImpossible(call: CompletionCall) {
  call.write({ event: { $case: "noEditImpossible", value: {} } });
}
