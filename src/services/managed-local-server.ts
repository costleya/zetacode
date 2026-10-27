import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CompletionClient } from "~/api/completion-client.ts";
import { CONTINUATION_MODEL_NAME, MODEL_NAME } from "~/core/constants.ts";
import { getLocalRuntimeSocketPath } from "~/core/local-runtime.ts";
import { formatManagedSetupStatus, parseManagedSetupStatus } from "./managed-setup-status.ts";

const execute = promisify(execFile);
export const EXPECTED_MANAGED_MODELS = [MODEL_NAME, CONTINUATION_MODEL_NAME] as const;
export const MANAGED_SERVER_LABEL = "com.nesweep.local-models";
export const HELPER_MANIFESTS = ["pyproject.toml", "uv.lock", ".python-version"] as const;
const STARTUP_TIMEOUT_MS = 30 * 60_000;

export function hasExpectedManagedModels(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const health = value as { status?: unknown; models?: unknown };
  return (
    health.status === "ok" &&
    Array.isArray(health.models) &&
    EXPECTED_MANAGED_MODELS.every((model) => (health.models as unknown[]).includes(model))
  );
}

export function escapePlist(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function findUv(): Promise<string> {
  const candidates = [
    ...(process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "uv")),
    path.join(os.homedir(), ".local", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ];
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, fs.constants.X_OK);
      await execute(candidate, ["--version"], { timeout: 5000 });
      return candidate;
    } catch {
      /* Try the next standard installation. */
    }
  }
  throw new Error(
    "Install uv from https://docs.astral.sh/uv/getting-started/installation/ and reload VS Code. NESweep does not install uv automatically.",
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export class ManagedLocalServer implements vscode.Disposable {
  private pending: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private disposed = false;
  private failure: unknown;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  get socketPath(): string {
    // A placeholder lets unsupported hosts activate and show the platform error.
    // prepare() rejects them before any socket connection or filesystem access.
    return getLocalRuntimeSocketPath(
      path.join(this.context.globalStorageUri.fsPath, "local-models"),
      process.getuid?.() ?? 0,
    );
  }

  ensureReady(retry = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("NESweep local setup was disposed."));
    if (this.pending) return this.pending;
    if (retry) this.failure = undefined;
    if (this.failure) return Promise.reject(this.failure);
    this.pending = this.prepare()
      .catch((error: unknown) => {
        this.failure = error;
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async validateSocket(): Promise<boolean> {
    const socketPath = this.socketPath;
    const uid = process.getuid!();
    try {
      const parent = await fs.lstat(path.dirname(socketPath));
      if (
        parent.isSymbolicLink() ||
        !parent.isDirectory() ||
        parent.uid !== uid ||
        (parent.mode & 0o7777) !== 0o700
      ) {
        throw new Error(
          `Refusing unsafe local model socket directory at ${path.dirname(socketPath)}. It must be a private directory owned by your Unix user with mode 0700.`,
        );
      }
      const socket = await fs.lstat(socketPath);
      if (
        socket.isSymbolicLink() ||
        !socket.isSocket() ||
        socket.uid !== uid ||
        (socket.mode & 0o7777) !== 0o600
      ) {
        throw new Error(
          `Refusing unsafe local model socket at ${socketPath}. It must be a socket owned by your Unix user with mode 0600.`,
        );
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async healthy(signal?: AbortSignal): Promise<boolean> {
    if (!(await this.validateSocket())) return false;
    const client = new CompletionClient({ socketPath: this.socketPath });
    try {
      const health = await client.health(signal);
      return hasExpectedManagedModels(health);
    } catch {
      return false;
    } finally {
      client.dispose();
    }
  }

  private async prepare(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      if (this.disposed) controller.abort();
      controller.signal.throwIfAborted();
      if (os.platform() !== "darwin" || os.arch() !== "arm64") {
        throw new Error(
          "NESweep requires Apple Silicon macOS to run its bundled Zeta and Qwen models.",
        );
      }
      const healthy = await this.healthy(controller.signal);
      controller.signal.throwIfAborted();
      if (healthy) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "NESweep: preparing local Zeta and Qwen models",
          cancellable: true,
        },
        async (progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            if (token.isCancellationRequested) controller.abort();
            let previousMessage = "";
            let previousLog = 0;
            let previousLogKey = "";
            await this.provision(controller.signal, (message, logKey = message) => {
              if (message === previousMessage) return;
              progress.report({ message });
              // Transfer counters change each second; retain useful periodic logs.
              if (Date.now() - previousLog >= 15_000 || logKey !== previousLogKey) {
                this.output.info(message);
                previousLog = Date.now();
                previousLogKey = logKey;
              }
              previousMessage = message;
            });
          } finally {
            subscription.dispose();
          }
        },
      );
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          "NESweep local model setup cancelled. Reload VS Code or use Check Local Models to retry.",
        );
      this.output.error("Local model setup failed", error);
      void vscode.window
        .showErrorMessage(
          `NESweep: ${error instanceof Error ? error.message : String(error)} See NESweep Output for details.`,
          "Show Output",
        )
        .then((action) => {
          if (action) this.output.show();
        });
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async provision(
    signal: AbortSignal,
    report: (message: string, logKey?: string) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const root = path.join(this.context.globalStorageUri.fsPath, "local-models");
    await fs.mkdir(root, { recursive: true });
    const release = await this.lock(root, signal, report);
    let installedArguments: string[] | undefined;
    let ready = false;
    const domain = `gui/${process.getuid!()}`;
    const service = `${domain}/${MANAGED_SERVER_LABEL}`;
    const plist = path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      `${MANAGED_SERVER_LABEL}.plist`,
    );
    try {
      signal.throwIfAborted();
      const healthy = await this.healthy(signal);
      signal.throwIfAborted();
      if (healthy) return;
      const uv = await findUv();
      const source = await this.stage(root);
      const python = path.join(root, "environment", "bin", "python");
      const log = path.join(root, "server.log");
      const environment = {
        ...process.env,
        UV_PROJECT_ENVIRONMENT: path.join(root, "environment"),
        HF_HOME: path.join(root, "huggingface"),
        UV_CACHE_DIR: path.join(root, "uv-cache"),
        UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
        PYTHONUNBUFFERED: "1",
        // Startup only: a healthy server keeps its existing environment until restarted.
        MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS:
          process.env["MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS"] ?? "1000",
      };
      const current = await this.readOwnedPlist(plist, root);
      const loaded = await this.loadedService(service);
      if (loaded && !current)
        throw new Error(
          `LaunchAgent ${service} already exists without NESweep ownership metadata. Remove the conflicting agent manually, then use Check Local Models to retry.`,
        );
      if (loaded && current) this.validateLoadedService(loaded, current);
      report("Installing the locked Python runtime and dependencies (first setup needs internet)…");
      await this.run(
        uv,
        ["sync", "--locked", "--project", source, "--no-dev"],
        environment,
        signal,
      );
      signal.throwIfAborted();
      if (loaded && current) {
        await execute("/bin/launchctl", ["bootout", service]);
        await this.waitForServiceExit(service, current, signal);
      }
      const setupId = randomUUID();
      const statusFile = path.join(root, "setup-status.json");
      const setupStartedAt = Date.now() / 1000;
      const args = [
        python,
        path.join(source, "src", "server.py"),
        "--socket-path",
        this.socketPath,
        "--status-file",
        statusFile,
        "--setup-id",
        setupId,
      ];
      const xml = this.plist(root, args, log, environment);
      await fs.mkdir(path.dirname(plist), { recursive: true });
      const temporary = `${plist}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, xml, { mode: 0o600 });
      await fs.rename(temporary, plist);
      installedArguments = args;
      signal.throwIfAborted();
      await execute("/bin/launchctl", ["bootstrap", domain, plist]);
      report(
        "Downloading missing checkpoints and loading Zeta + Qwen. Existing Hugging Face cache is reused…",
      );
      this.output.info(
        `Managed LaunchAgent: ${service}; model/runtime cache: ${root}; server logs: ${log}`,
      );
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!(await this.healthy(signal))) {
        signal.throwIfAborted();
        const status = await this.readSetupStatus(statusFile, setupId, setupStartedAt);
        signal.throwIfAborted();
        if (status) {
          const message = formatManagedSetupStatus(status);
          if (status.stage === "error") throw new Error(message);
          report(message, `${status.stage}:${status.model ?? "all"}`);
        } else {
          report(
            "Waiting for local model startup; checking downloads and loading. See NESweep Output and server.log for details…",
          );
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Local models did not become ready within 30 minutes. Check ${log} for download, disk space, or memory errors, then retry.`,
          );
        await this.delay(1000, signal);
      }
      signal.throwIfAborted();
      report("Both local models are ready.");
      ready = true;
    } finally {
      try {
        if (installedArguments && !ready) {
          const expectedArguments = installedArguments;
          // The lock is still held: no other activation can replace the service.
          const owned = await this.readOwnedPlist(plist, root);
          if (
            owned &&
            owned.length === expectedArguments.length &&
            owned.every((argument, index) => argument === expectedArguments[index])
          ) {
            const loaded = await this.loadedService(service);
            if (loaded) this.validateLoadedService(loaded, owned);
            if (loaded) {
              await execute("/bin/launchctl", ["bootout", service]);
              // Keep the setup lock until cancellation cleanup has unloaded too.
              await this.waitForServiceExit(service, owned, new AbortController().signal);
            }
            // An external replacement may have arrived while launchd was stopping.
            const latest = await this.readOwnedPlist(plist, root);
            if (
              latest &&
              latest.length === expectedArguments.length &&
              latest.every((argument, index) => argument === expectedArguments[index])
            ) {
              // Prevent this failed/cancelled setup from restarting at login.
              await fs.unlink(plist);
            }
          }
        }
      } catch (error) {
        // Cleanup must not hide the startup/cancellation failure that brought us here.
        this.output.error("Failed to clean up the managed local model startup", error);
      } finally {
        await release();
      }
    }
  }

  private async stage(root: string): Promise<string> {
    const bundled = path.join(this.context.extensionUri.fsPath, "tools", "zeta-server");
    const assets: { name: string; bytes: Buffer }[] = [];
    if (!(await fs.lstat(bundled)).isDirectory())
      throw new Error("Bundled helper must be a plain directory.");
    const collect = async (name: string): Promise<void> => {
      const file = path.join(bundled, name);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) {
        for (const child of (await fs.readdir(file)).sort()) {
          if (child === "__pycache__" || /\.(pyc|pyo)$/.test(child)) continue;
          await collect(path.join(name, child));
        }
      } else if (stat.isFile()) {
        assets.push({ name, bytes: await fs.readFile(file) });
      } else {
        throw new Error(`Bundled helper asset must be a plain file or directory: ${name}`);
      }
    };
    if (!(await fs.lstat(path.join(bundled, "src"))).isDirectory())
      throw new Error("Bundled helper src must be a plain directory.");
    await collect("src");
    for (const name of HELPER_MANIFESTS) {
      const file = path.join(bundled, name);
      if (!(await fs.lstat(file)).isFile())
        throw new Error(`Bundled helper manifest must be a plain file: ${name}`);
      assets.push({ name, bytes: await fs.readFile(file) });
    }
    assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const hash = createHash("sha256");
    for (const asset of assets)
      hash.update(`${asset.name.length}:${asset.name}${asset.bytes.length}:`).update(asset.bytes);
    const destination = path.join(root, "sources", hash.digest("hex"));
    if (await exists(path.join(destination, ".complete"))) return destination;
    await fs.mkdir(destination, { recursive: true });
    for (const asset of assets) {
      const file = path.join(destination, asset.name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, asset.bytes);
    }
    await fs.writeFile(path.join(destination, ".complete"), "ready\n");
    return destination;
  }

  private async readSetupStatus(file: string, setupId: string, startedAt: number) {
    // Bound the actual read as well as parsing; telemetry must never block setup.
    try {
      const handle = await fs.open(file, "r");
      try {
        const buffer = Buffer.alloc(16_385);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16_384) return undefined;
        return parseManagedSetupStatus(
          JSON.parse(buffer.toString("utf8", 0, bytesRead)),
          setupId,
          Date.now() / 1000,
          startedAt,
        );
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  private plist(root: string, args: string[], log: string, environment: NodeJS.ProcessEnv): string {
    const variables = [
      "HF_HOME",
      "UV_CACHE_DIR",
      "UV_PYTHON_INSTALL_DIR",
      "PYTHONUNBUFFERED",
      "MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS",
      ...[
        "OTEL_TRACES_EXPORTER",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
        "OTEL_EXPORTER_OTLP_PROTOCOL",
      ].filter((key) => environment[key] !== undefined),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${MANAGED_SERVER_LABEL}</string>
<key>NESweepStorageRoot</key><string>${escapePlist(root)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapePlist(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${variables.map((key) => `<key>${key}</key><string>${escapePlist(environment[key] ?? "")}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${escapePlist(log)}</string><key>StandardErrorPath</key><string>${escapePlist(log)}</string>
</dict></plist>\n`;
  }

  private async readOwnedPlist(file: string, root: string): Promise<string[] | undefined> {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing to change unrecognized LaunchAgent at ${file}. It must be a plain file.`,
      );
    }
    const { stdout } = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
    const value = JSON.parse(stdout) as {
      Label?: string;
      NESweepStorageRoot?: string;
      ProgramArguments?: unknown;
    };
    const args = value.ProgramArguments;
    if (
      value.Label !== MANAGED_SERVER_LABEL ||
      value.NESweepStorageRoot !== root ||
      !Array.isArray(args) ||
      args.length !== 8 ||
      args[0] !== path.join(root, "environment", "bin", "python") ||
      typeof args[1] !== "string" ||
      !/^sources\/[a-f0-9]{64}\/src\/server\.py$/.test(path.relative(root, args[1])) ||
      args[2] !== "--socket-path" ||
      args[3] !== this.socketPath ||
      args[4] !== "--status-file" ||
      args[5] !== path.join(root, "setup-status.json") ||
      args[6] !== "--setup-id" ||
      typeof args[7] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args[7])
    ) {
      throw new Error(
        `Refusing to change unrecognized LaunchAgent at ${file}. Remove it manually, then use Check Local Models to retry.`,
      );
    }
    return args as string[];
  }

  private async loadedService(service: string): Promise<string | undefined> {
    try {
      return (await execute("/bin/launchctl", ["print", service])).stdout;
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (failure.code === 113 || /Could not find service/.test(failure.stderr ?? ""))
        return undefined;
      throw error;
    }
  }

  private validateLoadedService(output: string, args: string[]): void {
    // launchctl's program and argument records must identify the owned runtime.
    if (!output.includes(`program = ${args[0]}`) || !args.every((arg) => output.includes(arg))) {
      throw new Error(
        "Refusing to stop a LaunchAgent whose running program does not match NESweep's managed runtime.",
      );
    }
  }

  private async waitForServiceExit(
    service: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<void> {
    // bootout can return while launchd is still removing the old registration.
    // Reusing the label sooner makes bootstrap fail with an input/output error.
    const deadline = Date.now() + 30_000;
    for (;;) {
      signal.throwIfAborted();
      const loaded = await this.loadedService(service);
      signal.throwIfAborted();
      if (!loaded) return;
      this.validateLoadedService(loaded, args);
      if (Date.now() >= deadline) {
        throw new Error(
          "The previous NESweep local model service did not finish stopping. Use Check Local Models to retry.",
        );
      }
      await this.delay(100, signal);
    }
  }

  private async run(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      // A separate group lets cancellation stop uv's Python/download children too.
      const child = spawn(command, args, {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const cancel = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              this.output.error("Could not cancel Python setup process group", error);
          }
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      this.output.info(
        `Provisioning process group ${child.pid ?? "starting"} (parent ${process.pid}): ${command} ${args.join(" ")}`,
      );
      child.stdout.on("data", (data: Buffer) => this.output.info(data.toString().trimEnd()));
      child.stderr.on("data", (data: Buffer) => this.output.info(data.toString().trimEnd()));
      child.on("error", (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(new Error("Python setup cancelled"));
        } else if (code === 0) resolve();
        else
          reject(
            new Error(
              `Python dependency setup exited with ${code}; check NESweep Output and internet connectivity.`,
            ),
          );
      });
    });
  }

  private async lock(
    root: string,
    signal: AbortSignal,
    report: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let collisions = 0;
    while (true) {
      signal.throwIfAborted();
      if (Date.now() > deadline)
        throw new Error(
          `Another window is still preparing models. Check ${root} and NESweep Output before retrying.`,
        );
      const generation = await this.highestLockGeneration(root);
      const previous = generation === undefined ? undefined : this.lockPath(root, generation);
      if (!previous || (await this.canAdvanceLock(previous))) {
        const next = generation === undefined ? 0 : generation + 1;
        if (next > 10_000)
          throw new Error(
            `NESweep setup lock history at ${root} reached its safety limit. Close all VS Code windows before clearing setup.lock metadata files.`,
          );
        const file = this.lockPath(root, next);
        signal.throwIfAborted();
        try {
          await this.publishLock(file, owner);
          return async () => {
            // Owner records and release markers are immutable. Never remove a
            // shared path: a paused contender cannot unlink a newer owner.
            try {
              await fs.writeFile(`${file}.released`, owner, { flag: "wx", mode: 0o600 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Another window claimed this generation; rescan its immutable owner.
          if (++collisions < 16) continue;
        }
      }
      collisions = 0;
      report("Waiting for another VS Code window to finish model setup…");
      await this.delay(1000, signal);
    }
  }

  private lockPath(root: string, generation: number): string {
    return path.join(root, generation === 0 ? "setup.lock" : `setup.lock.${generation}`);
  }

  private async highestLockGeneration(root: string): Promise<number | undefined> {
    let highest: number | undefined;
    let entries = 0;
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      if (++entries > 30_100)
        throw new Error(
          `NESweep storage at ${root} contains too many metadata entries; inspect it before retrying setup.`,
        );
      // Publication temporaries, release markers and legacy recovery files do
      // not participate in ownership or generation selection.
      const match = /^setup\.lock(?:\.([1-9][0-9]*))?$/.exec(entry.name);
      if (!match) continue;
      const generation = match[1] === undefined ? 0 : Number(match[1]);
      if (!Number.isSafeInteger(generation) || generation > 10_000)
        throw new Error(
          `Unrecognized NESweep setup lock generation at ${root}. Inspect the metadata before retrying.`,
        );
      highest = Math.max(highest ?? 0, generation);
    }
    return highest;
  }

  private async publishLock(file: string, owner: string): Promise<void> {
    // link() publishes complete metadata exclusively, so a crash cannot leave
    // an empty lock between exclusive creation and writing its owner.
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, owner, { flag: "wx", mode: 0o600 });
    try {
      await fs.link(temporary, file);
    } finally {
      await fs.unlink(temporary);
    }
  }

  private async canAdvanceLock(file: string): Promise<boolean> {
    if (await exists(`${file}.released`)) return true;
    try {
      const before = await fs.stat(file);
      const previous = await fs.readFile(file, "utf8");
      let pid: unknown;
      try {
        pid = (JSON.parse(previous) as { pid?: unknown }).pid;
      } catch {
        /* Legacy partial lock. */
      }
      const ownerPid =
        typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
      if (Date.now() - before.mtimeMs < (ownerPid ? 5000 : 30_000)) return false;
      if (ownerPid) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An external actor removed history; rescan instead of taking ownership
      // based on a generation that disappeared.
      return false;
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new Error("Setup cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, ms);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
  }
}
