import { describe, expect, test } from "vite-plus/test";
import {
  formatManagedSetupStatus,
  parseManagedSetupStatus,
  type ManagedSetupStatus,
} from "~/services/managed-setup-status.ts";

const setupId = "67ff8c7c-8ab2-4cec-8d5c-a491bc888038";
const now = 1_800_000_000;

function status(changes: Record<string, unknown> = {}): ManagedSetupStatus {
  return {
    schema_version: 1,
    setup_id: setupId,
    stage: "downloading",
    model: "Zeta",
    model_index: 1,
    model_count: 2,
    updated_at: now,
    ...changes,
  } as ManagedSetupStatus;
}

describe("managed setup status validation", () => {
  test("accepts current session telemetry for each model and each setup stage", () => {
    for (const stage of ["resolving", "downloading", "loading"] as const) {
      for (const [model, model_index] of [
        ["Zeta", 1],
        ["Qwen", 2],
      ] as const) {
        const value = status({ stage, model, model_index });
        expect(parseManagedSetupStatus(value, setupId, now, now - 10)).toEqual(value);
      }
    }
    for (const stage of ["ready", "error"]) {
      const value = { schema_version: 1, setup_id: setupId, stage, updated_at: now };
      expect(parseManagedSetupStatus(value, setupId, now)).toEqual(value);
    }
  });

  test.each([
    undefined,
    null,
    [],
    "not JSON",
    {},
    status({ schema_version: 2 }),
    status({ stage: "complete" }),
    status({ setup_id: "e8277f5b-a7b4-4b15-b57a-f478b41536df" }),
    status({ updated_at: now - 31 }),
    status({ updated_at: now + 6 }),
    status({ updated_at: Number.NaN }),
    status({ updated_at: "today" }),
    status({ model: "other" }),
    status({ model_index: 2 }),
    status({ model_count: 1 }),
    status({ model: undefined }),
    status({ message: "a".repeat(301) }),
    status({ message: "hidden\nline" }),
    status({ message: "hidden\u001b[31mtext" }),
  ])("ignores malformed, stale, or unrelated telemetry without throwing: %j", (value) => {
    expect(parseManagedSetupStatus(value, setupId, now)).toBeUndefined();
  });

  test("rejects telemetry predating this attempt even while otherwise fresh", () => {
    expect(
      parseManagedSetupStatus(status({ updated_at: now - 5 }), setupId, now, now),
    ).toBeUndefined();
    expect(
      parseManagedSetupStatus(status({ updated_at: now - 1 }), setupId, now, now),
    ).toBeDefined();
  });

  test("requires a UUID session even when the supplied identifier matches", () => {
    expect(parseManagedSetupStatus(status({ setup_id: "old" }), "old", now)).toBeUndefined();
  });

  test("allows missing metrics and zero without inventing values", () => {
    expect(parseManagedSetupStatus(status(), setupId, now)).toEqual(status());
    const value = status({
      downloaded_bytes: 0,
      total_bytes: 0,
      speed_bytes_per_second: 0,
      eta_seconds: 0,
    });
    expect(parseManagedSetupStatus(value, setupId, now)).toEqual(value);
  });

  test.each([
    "downloaded_bytes",
    "total_bytes",
    "speed_bytes_per_second",
    "eta_seconds",
    "reconstructed_bytes",
    "reconstruction_total_bytes",
  ])("rejects invalid %s measurements", (metric) => {
    for (const value of [-1, Number.NaN, Infinity, -Infinity, "5", null, true]) {
      expect(parseManagedSetupStatus(status({ [metric]: value }), setupId, now)).toBeUndefined();
    }
  });

  test("requires a complete consistent model identity on overall statuses if present", () => {
    for (const stage of ["ready", "error"]) {
      expect(
        parseManagedSetupStatus(status({ stage, model_index: undefined }), setupId, now),
      ).toBeUndefined();
    }
  });

  test("accepts only boolean total estimation flags", () => {
    for (const flag of [true, false]) {
      const value = status({ total_bytes_estimated: flag });
      expect(parseManagedSetupStatus(value, setupId, now)).toEqual(value);
    }
    for (const flag of [null, 0, 1, "true", {}, []]) {
      expect(
        parseManagedSetupStatus(status({ total_bytes_estimated: flag }), setupId, now),
      ).toBeUndefined();
    }
  });
});

describe("managed setup notice", () => {
  test("shows compact download rate and separate assembly percentage", () => {
    const message = formatManagedSetupStatus(
      status({
        model: "Qwen",
        model_index: 2,
        downloaded_bytes: 400,
        total_bytes: 1000,
        speed_bytes_per_second: 29_500_000,
        reconstructed_bytes: 30,
        reconstruction_total_bytes: 1000,
        eta_seconds: 120,
      }),
    );
    expect(message).toBe("Qwen (2/2): Downloading 40% (29.5 MB/s) · Assembling 3%");
    expect(message).not.toMatch(/received|saved|KiB|MiB|GiB|left|min|ETA/);
  });

  test.each([undefined, 0])(
    "does not invent a percentage, speed, or ETA for unknown totals %j",
    (total_bytes) => {
      const message = formatManagedSetupStatus(
        status({ downloaded_bytes: 1024, total_bytes, eta_seconds: 60 }),
      );
      expect(message).toBe("Zeta (1/2): Downloading…");
      expect(message).not.toMatch(/%|MB\/s|left/);
    },
  );

  test("resumed or cached bytes alone do not imply a transfer speed or ETA", () => {
    const message = formatManagedSetupStatus(
      status({
        downloaded_bytes: 1024,
        total_bytes: 2048,
        eta_seconds: 0,
      }),
    );
    expect(message).toBe("Zeta (1/2): Downloading 50%");
    expect(message).not.toMatch(/MB\/s|left/);
  });

  test("keeps estimated network percentage separate from the exact assembly percentage", () => {
    const message = formatManagedSetupStatus(
      status({
        downloaded_bytes: 400,
        total_bytes: 1000,
        total_bytes_estimated: true,
        reconstructed_bytes: 30,
        reconstruction_total_bytes: 1000,
        speed_bytes_per_second: 1_000_000,
      }),
    );
    expect(message).toBe("Zeta (1/2): Downloading ~40% (1.0 MB/s) · Assembling 3%");
    expect(message).not.toMatch(/Assembling ~|received|saved|left/);
  });

  test("omits ETA when a network rate is measured but a meaningful total is unknown", () => {
    const message = formatManagedSetupStatus(
      status({
        downloaded_bytes: 1_000_000,
        speed_bytes_per_second: 1_000_000,
        eta_seconds: 120,
      }),
    );
    expect(message).toBe("Zeta (1/2): Downloading (1.0 MB/s)");
    expect(message).not.toMatch(/%|left/);
  });

  test.each([undefined, false])(
    "does not mark exact totals as estimates (%j)",
    (total_bytes_estimated) => {
      expect(
        formatManagedSetupStatus(
          status({ downloaded_bytes: 20, total_bytes: 100, total_bytes_estimated }),
        ),
      ).toBe("Zeta (1/2): Downloading 20%");
    },
  );

  test("clamps measured network and assembly percentages to one hundred", () => {
    expect(
      formatManagedSetupStatus(
        status({
          downloaded_bytes: 200,
          total_bytes: 100,
          reconstructed_bytes: 300,
          reconstruction_total_bytes: 100,
        }),
      ),
    ).toBe("Zeta (1/2): Downloading 100% · Assembling 100%");
  });

  test("caps estimated network progress below completion even when the reported total is reached", () => {
    for (const downloaded_bytes of [100, 100.5, 200]) {
      expect(
        formatManagedSetupStatus(
          status({ downloaded_bytes, total_bytes: 100, total_bytes_estimated: true }),
        ),
      ).toBe("Zeta (1/2): Downloading ~99%");
    }
  });

  test("shows a measured zero rate without inventing an ETA", () => {
    expect(
      formatManagedSetupStatus(
        status({
          downloaded_bytes: 0,
          total_bytes: 100,
          speed_bytes_per_second: 0,
          eta_seconds: 120,
        }),
      ),
    ).toBe("Zeta (1/2): Downloading 0% (0.0 MB/s)");
  });

  test("reports zero progress honestly and omits unknown ratios", () => {
    expect(
      formatManagedSetupStatus(
        status({
          downloaded_bytes: 0,
          total_bytes: 100,
          total_bytes_estimated: true,
          reconstructed_bytes: 0,
          reconstruction_total_bytes: 100,
        }),
      ),
    ).toBe("Zeta (1/2): Downloading ~0% · Assembling 0%");
    expect(
      formatManagedSetupStatus(status({ total_bytes: 100, reconstruction_total_bytes: 100 })),
    ).toBe("Zeta (1/2): Downloading…");
    expect(
      formatManagedSetupStatus(
        status({
          downloaded_bytes: 0,
          total_bytes: 0,
          reconstructed_bytes: 100,
          reconstruction_total_bytes: 0,
        }),
      ),
    ).toBe("Zeta (1/2): Downloading… · Assembling…");
  });

  test("distinguishes resolving, memory loading, and health verification", () => {
    expect(formatManagedSetupStatus(status({ stage: "resolving" }))).toMatch(
      /Zeta.*cached.*metadata/i,
    );
    expect(formatManagedSetupStatus(status({ stage: "loading" }))).toMatch(
      /Zeta.*loading.*memory/i,
    );
    expect(formatManagedSetupStatus(status({ stage: "ready" }))).toMatch(/checking both.*health/i);
    expect(formatManagedSetupStatus(status({ stage: "loading" }))).not.toMatch(/%|MB\/s|left/);
  });

  test("displays a safe failure message and provides a useful fallback", () => {
    expect(
      formatManagedSetupStatus(status({ stage: "error", message: "Download failed: disk full." })),
    ).toContain("disk full");
    expect(formatManagedSetupStatus(status({ stage: "error" }))).toMatch(/failed.*server\.log/i);
  });
});
