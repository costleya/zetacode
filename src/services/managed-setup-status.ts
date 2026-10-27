export interface ManagedSetupStatus {
  schema_version: 1;
  setup_id: string;
  stage: "resolving" | "downloading" | "loading" | "ready" | "error";
  model?: "Zeta" | "Qwen";
  model_index?: 1 | 2;
  model_count?: 2;
  downloaded_bytes?: number;
  total_bytes?: number;
  total_bytes_estimated?: boolean;
  reconstructed_bytes?: number;
  reconstruction_total_bytes?: number;
  speed_bytes_per_second?: number;
  eta_seconds?: number;
  updated_at: number;
  message?: string;
}

const stages = new Set(["resolving", "downloading", "loading", "ready", "error"]);
const metrics = [
  "downloaded_bytes",
  "total_bytes",
  "reconstructed_bytes",
  "reconstruction_total_bytes",
  "speed_bytes_per_second",
  "eta_seconds",
] as const;

/** Ignore unrelated, stale or malformed telemetry without affecting server health checks. */
export function parseManagedSetupStatus(
  value: unknown,
  setupId: string,
  nowSeconds = Date.now() / 1000,
  startedAtSeconds = 0,
): ManagedSetupStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = value as Record<string, unknown>;
  if (
    status["schema_version"] !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(setupId) ||
    status["setup_id"] !== setupId ||
    typeof status["stage"] !== "string" ||
    !stages.has(status["stage"]) ||
    typeof status["updated_at"] !== "number" ||
    !Number.isFinite(status["updated_at"]) ||
    status["updated_at"] < Math.max(startedAtSeconds - 1, nowSeconds - 30) ||
    status["updated_at"] > nowSeconds + 5
  )
    return undefined;
  const perModel = status["stage"] !== "ready" && status["stage"] !== "error";
  if (
    perModel ||
    status["model"] !== undefined ||
    status["model_index"] !== undefined ||
    status["model_count"] !== undefined
  ) {
    if (
      (status["model"] !== "Zeta" && status["model"] !== "Qwen") ||
      status["model_index"] !== (status["model"] === "Zeta" ? 1 : 2) ||
      status["model_count"] !== 2
    )
      return undefined;
  }
  for (const key of metrics) {
    const metric = status[key];
    if (
      metric !== undefined &&
      (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0)
    )
      return undefined;
  }
  if (
    status["total_bytes_estimated"] !== undefined &&
    typeof status["total_bytes_estimated"] !== "boolean"
  )
    return undefined;
  if (
    status["message"] !== undefined &&
    (typeof status["message"] !== "string" ||
      status["message"].length > 300 ||
      Array.from(status["message"]).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }))
  )
    return undefined;
  return value as ManagedSetupStatus;
}

function percentage(value: number, total: number): number {
  return Math.max(0, Math.min(100, Math.floor((value / total) * 100)));
}

export function formatManagedSetupStatus(status: ManagedSetupStatus): string {
  const model = status.model ? `${status.model} (${status.model_index}/2): ` : "";
  switch (status.stage) {
    case "resolving":
      return `${model}Checking cached files and resolving checkpoint metadata…`;
    case "loading":
      return `${model}Loading model into memory…`;
    case "ready":
      return "Models loaded; checking both local model health IDs…";
    case "error":
      return `${model}${status.message?.trim() || "Model setup failed. Check server.log for details."}`;
    case "downloading": {
      const downloadPercentage =
        status.downloaded_bytes !== undefined && status.total_bytes && status.total_bytes > 0
          ? ` ${status.total_bytes_estimated ? "~" : ""}${Math.min(status.total_bytes_estimated ? 99 : 100, percentage(status.downloaded_bytes, status.total_bytes))}%`
          : "";
      const speed =
        status.speed_bytes_per_second !== undefined
          ? ` (${(status.speed_bytes_per_second / 1_000_000).toFixed(1)} MB/s)`
          : "";
      const parts = [
        `Downloading${downloadPercentage}${speed}${!downloadPercentage && !speed ? "…" : ""}`,
      ];
      if (status.reconstructed_bytes !== undefined) {
        // Model-file assembly has a separate total from network transfers.
        parts.push(
          status.reconstruction_total_bytes && status.reconstruction_total_bytes > 0
            ? `Assembling ${percentage(status.reconstructed_bytes, status.reconstruction_total_bytes)}%`
            : "Assembling…",
        );
      }
      return `${model}${parts.join(" · ")}`;
    }
  }
}
