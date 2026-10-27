import { createHash } from "node:crypto";
import * as path from "node:path";

// Keep the socket outside potentially deep global-storage paths on macOS.
export function getLocalRuntimeSocketPath(
  storageRoot: string,
  uid: number | undefined = process.getuid?.(),
): string {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("NESweep requires a valid local Unix user ID to run its bundled models.");
  }
  const identity = createHash("sha256")
    .update(path.resolve(storageRoot))
    .digest("hex")
    .slice(0, 16);
  const socketPath = `/tmp/nesweep-${uid}/${identity}.sock`;
  if (Buffer.byteLength(socketPath, "utf8") > 103) {
    throw new Error("NESweep local model socket path exceeds the macOS Unix socket limit.");
  }
  return socketPath;
}
