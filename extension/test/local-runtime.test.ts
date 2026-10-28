import * as path from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { getLocalRuntimeSocketPath } from "~/core/local-runtime.ts";

describe("managed local socket identity", () => {
  test("uses the resolved storage root and Unix user in a stable socket path", () => {
    expect(getLocalRuntimeSocketPath("/profiles/work/local-models", 501)).toBe(
      "/tmp/nesweep-501/f6bb5946c932e6f1.sock",
    );
    expect(getLocalRuntimeSocketPath("/profiles/work/../work/local-models", 501)).toBe(
      getLocalRuntimeSocketPath("/profiles/work/local-models", 501),
    );
    expect(getLocalRuntimeSocketPath("local-models", 501)).toBe(
      getLocalRuntimeSocketPath(path.resolve("local-models"), 501),
    );
  });

  test("isolates different profiles and users while sharing an identity between windows", () => {
    const firstWindow = getLocalRuntimeSocketPath("/profiles/work/local-models", 501);
    expect(getLocalRuntimeSocketPath("/profiles/work/local-models", 501)).toBe(firstWindow);
    expect(getLocalRuntimeSocketPath("/profiles/personal/local-models", 501)).not.toBe(firstWindow);
    expect(getLocalRuntimeSocketPath("/profiles/work/local-models", 502)).not.toBe(firstWindow);
  });

  test("keeps long Unicode storage paths within Darwin's 103-byte socket limit", () => {
    const storage = `/Users/user/${"設定とモデル/".repeat(100)}local-models`;
    const socket = getLocalRuntimeSocketPath(storage, 501);
    expect(Buffer.byteLength(socket, "utf8")).toBeLessThanOrEqual(103);
    expect(socket).toMatch(/^\/tmp\/nesweep-501\/[a-f0-9]{16}\.sock$/);
    expect(socket).not.toContain("設定");
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid user identity %s",
    (uid) => {
      expect(() => getLocalRuntimeSocketPath("/profiles/work/local-models", uid)).toThrow(
        /user ID/,
      );
    },
  );

  test("rejects a missing native user identity", () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
    try {
      expect(() => getLocalRuntimeSocketPath("/profiles/work/local-models")).toThrow(/user ID/);
    } finally {
      getuid.mockRestore();
    }
  });
});
