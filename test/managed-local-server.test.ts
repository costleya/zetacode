import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vite-plus/test";

const BUNDLED_FILES = [
  "src/server.py",
  "src/decoder.py",
  "src/continuation_decoder.py",
  "src/setup_progress.py",
  "src/proto/completion.proto",
  "src/completion_pb2.py",
  "src/completion_pb2_grpc.py",
  "src/unix_grpc_server.py",
  "pyproject.toml",
  "uv.lock",
  ".python-version",
];

const processes = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn() }));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    platform: vi.fn(original.platform),
    arch: vi.fn(original.arch),
    homedir: vi.fn(original.homedir),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    access: vi.fn(original.access),
    link: vi.fn(original.link),
    lstat: vi.fn(original.lstat),
  };
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: processes.execute }),
    spawn: processes.spawn,
  };
});

vi.mock("vscode", () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: vi.fn(),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  },
}));

import {
  hasExpectedManagedModels,
  findUv,
  ManagedLocalServer,
} from "~/services/managed-local-server.ts";
import { window } from "vscode";
import { CompletionClient } from "~/api/completion-client.ts";
import { getLocalRuntimeSocketPath } from "~/core/local-runtime.ts";
import { CompletionServer } from "~/services/completion-server.ts";

let temporary: string;
let extension: string;
let storage: string;
let cancel: (() => void) | undefined;
let healthy: boolean;
let health: MockInstance<CompletionClient["health"]>;
let socketDirectory: Stats;
let socketEntry: Stats;

function socketPath(): string {
  return getLocalRuntimeSocketPath(path.join(storage, "local-models"));
}
const servers: ManagedLocalServer[] = [];
const output = { info: vi.fn(), error: vi.fn(), show: vi.fn() };

function manager(): ManagedLocalServer {
  const server = new ManagedLocalServer(
    {
      extensionUri: { fsPath: extension },
      globalStorageUri: { fsPath: storage },
    } as vscode.ExtensionContext,
    output as unknown as vscode.LogOutputChannel,
  );
  servers.push(server);
  return server;
}

function currentProgramArguments(root: string, entry = "src/server.py"): string[] {
  return [
    path.join(root, "environment/bin/python"),
    path.join(root, "sources", "a".repeat(64), entry),
    "--socket-path",
    getLocalRuntimeSocketPath(root),
    "--status-file",
    path.join(root, "setup-status.json"),
    "--setup-id",
    "67ff8c7c-8ab2-4cec-8d5c-a491bc888038",
  ];
}

function nextSetupReport(): Promise<void> {
  let report!: () => void;
  const reported = new Promise<void>((resolve) => {
    report = resolve;
  });
  vi.mocked(window.withProgress).mockImplementationOnce(async (_options, task) =>
    task(
      { report },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
      },
    ),
  );
  return reported;
}

async function installedProgramArguments(): Promise<string[]> {
  const plist = await fs.readFile(
    path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist"),
    "utf8",
  );
  const array = plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)![1]!;
  return [...array.matchAll(/<string>(.*?)<\/string>/gs)].map((match) =>
    match[1]!.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
  );
}

async function publishSetupStatus(changes: Record<string, unknown>): Promise<void> {
  const args = await installedProgramArguments();
  await fs.writeFile(
    args[5]!,
    JSON.stringify({
      schema_version: 1,
      setup_id: args[7],
      stage: "downloading",
      model: "Zeta",
      model_index: 1,
      model_count: 2,
      updated_at: Date.now() / 1000,
      ...changes,
    }),
  );
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nesweep-runtime-test-"));
  extension = path.join(temporary, "extension & <new>");
  storage = path.join(temporary, "storage & <models>");
  const bundled = path.join(extension, "tools", "zeta-server");
  await fs.mkdir(bundled, { recursive: true });
  await Promise.all(
    BUNDLED_FILES.map(async (name) => {
      const file = path.join(bundled, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `fixture ${name}\n`);
    }),
  );
  await fs.mkdir(path.join(bundled, ".venv"));
  await fs.writeFile(path.join(bundled, ".venv", "not-bundled"), "secret runtime");
  healthy = false;
  cancel = undefined;
  vi.mocked(os.platform).mockReturnValue("darwin");
  vi.mocked(os.arch).mockReturnValue("arm64");
  vi.mocked(os.homedir).mockReturnValue(temporary);
  vi.stubEnv("PATH", "/test/bin");
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  socketDirectory = Object.assign(await actualFs.lstat(temporary), {
    uid: process.getuid!(),
    mode: 0o40700,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isSocket: () => false,
  });
  socketEntry = Object.assign(await actualFs.lstat(temporary), {
    uid: process.getuid!(),
    mode: 0o140600,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isSocket: () => true,
  });
  vi.mocked(fs.lstat)
    .mockReset()
    .mockImplementation(async (file, options) => {
      if (file === path.dirname(socketPath())) return socketDirectory;
      if (file === socketPath()) return socketEntry;
      return actualFs.lstat(file, options);
    });
  vi.mocked(fs.link).mockReset().mockImplementation(actualFs.link);
  vi.mocked(fs.access)
    .mockReset()
    .mockImplementation(async (file, mode) => {
      if (String(file).endsWith("/uv")) {
        if (file === "/opt/homebrew/bin/uv") return;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return actualFs.access(file, mode);
    });
  vi.mocked(window.withProgress)
    .mockReset()
    .mockImplementation(async (_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: false,
          onCancellationRequested: (listener) => {
            cancel = () => listener(undefined);
            return { dispose: vi.fn() };
          },
        },
      ),
    );
  processes.execute.mockReset().mockImplementation(async (_command, args: string[]) => {
    if (args[0] === "print") throw Object.assign(new Error("missing service"), { code: 113 });
    if (args[0] === "bootstrap") healthy = true;
    return { stdout: "", stderr: "" };
  });
  processes.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected TCP health probe");
    }),
  );
  health = vi.spyOn(CompletionClient.prototype, "health").mockImplementation(async () => ({
    status: healthy ? "ok" : "starting",
    models: ["zeta-2.1", "qwen2.5-coder-7b-instruct"],
  }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.dispose();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("managed runtime provisioning", () => {
  test.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
  ] as const)("reports unsupported %s/%s once until explicit retry", async (platform, arch) => {
    vi.mocked(os.platform).mockReturnValue(platform);
    vi.mocked(os.arch).mockReturnValue(arch);
    vi.mocked(window.showErrorMessage).mockClear();
    output.error.mockClear();
    const mkdir = vi.spyOn(fs, "mkdir");
    const readFile = vi.spyOn(fs, "readFile");
    const managed = manager();
    const completion = new CompletionServer(managed.socketPath, (retry) =>
      managed.ensureReady(retry),
    );

    await expect(managed.ensureReady()).rejects.toThrow(/Apple Silicon macOS/);
    expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/Apple Silicon macOS.*NESweep Output/),
      "Show Output",
    );
    expect(output.error).toHaveBeenCalledExactlyOnceWith(
      "Local model setup failed",
      expect.objectContaining({ message: expect.stringContaining("Apple Silicon macOS") }),
    );

    // Ordinary completion attempts reuse the failure without repeating the alert.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(completion.waitUntilReady()).rejects.toThrow(/Apple Silicon macOS/);
    }
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(output.error).toHaveBeenCalledTimes(1);

    // Check Local Models explicitly retries, even though ensureReachable returns false.
    await expect(completion.ensureReachable()).resolves.toBe(false);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
    expect(output.error).toHaveBeenCalledTimes(2);
    await expect(completion.waitUntilReady()).rejects.toThrow(/Apple Silicon macOS/);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
    expect(output.error).toHaveBeenCalledTimes(2);
    expect(health).not.toHaveBeenCalled();
    expect(fs.access).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(window.withProgress).not.toHaveBeenCalled();
    expect(processes.execute).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();

    vi.mocked(os.platform).mockReturnValue("darwin");
    vi.mocked(os.arch).mockReturnValue("arm64");
    healthy = true;
    await expect(completion.waitUntilReady(true)).resolves.toBeUndefined();
    expect(health).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
    expect(output.error).toHaveBeenCalledTimes(2);
  });

  test("reports the native platform error when Unix user IDs are unavailable", async () => {
    vi.mocked(os.platform).mockReturnValue("win32");
    vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
    const mkdir = vi.spyOn(fs, "mkdir");
    const readFile = vi.spyOn(fs, "readFile");
    const managed = manager();
    const completion = new CompletionServer(managed.socketPath, (retry) =>
      managed.ensureReady(retry),
    );

    await expect(completion.waitUntilReady()).rejects.toThrow(/Apple Silicon macOS/);
    await expect(completion.ensureReachable()).resolves.toBe(false);
    expect(health).not.toHaveBeenCalled();
    expect(fs.access).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(processes.execute).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  test.each([
    { entry: "directory", flaw: "foreign owner" },
    { entry: "directory", flaw: "public permissions" },
    { entry: "directory", flaw: "special permission bits" },
    { entry: "directory", flaw: "symlink" },
    { entry: "directory", flaw: "regular file" },
    { entry: "socket", flaw: "foreign owner" },
    { entry: "socket", flaw: "public permissions" },
    { entry: "socket", flaw: "special permission bits" },
    { entry: "socket", flaw: "symlink" },
    { entry: "socket", flaw: "regular file" },
    { entry: "socket", flaw: "directory" },
  ])(
    "rejects a $entry with $flaw before probing a fake healthy server",
    async ({ entry, flaw }) => {
      healthy = true;
      const metadata = entry === "directory" ? socketDirectory : socketEntry;
      if (flaw === "foreign owner") metadata.uid = process.getuid!() + 1;
      if (flaw === "public permissions") metadata.mode |= 0o044;
      if (flaw === "special permission bits") metadata.mode |= 0o4000;
      if (flaw === "symlink") metadata.isSymbolicLink = () => true;
      if (flaw === "regular file") {
        metadata.isDirectory = () => false;
        metadata.isSocket = () => false;
      }
      if (flaw === "directory") {
        metadata.isDirectory = () => true;
        metadata.isSocket = () => false;
      }
      const mutations = [
        vi.spyOn(fs, "mkdir"),
        vi.spyOn(fs, "writeFile"),
        vi.spyOn(fs, "rename"),
        vi.spyOn(fs, "unlink"),
        vi.spyOn(fs, "chmod"),
        vi.spyOn(fs, "chown"),
      ];
      const managed = manager();
      const completion = new CompletionServer(managed.socketPath, (retry) =>
        managed.ensureReady(retry),
      );
      const ping = vi.spyOn(CompletionClient.prototype, "ping").mockResolvedValue(true);

      await expect(completion.waitUntilReady()).rejects.toThrow(
        /socket|directory|permission|owner/i,
      );
      expect(health).not.toHaveBeenCalled();
      expect(ping).not.toHaveBeenCalled();
      expect(window.withProgress).not.toHaveBeenCalled();
      expect(fs.link).not.toHaveBeenCalled();
      expect(fs.access).not.toHaveBeenCalled();
      for (const mutate of mutations) expect(mutate).not.toHaveBeenCalled();
      expect(processes.execute).not.toHaveBeenCalled();
      expect(processes.spawn).not.toHaveBeenCalled();
    },
  );

  test.each(["directory", "socket"])("provisions when the socket %s is missing", async (entry) => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation(async (file, options) => {
      if (file === path.dirname(socketPath()) || file === socketPath()) {
        if (
          !healthy &&
          file === (entry === "directory" ? path.dirname(socketPath()) : socketPath())
        )
          throw Object.assign(new Error("missing socket path"), { code: "ENOENT" });
        return file === socketPath() ? socketEntry : socketDirectory;
      }
      return actualFs.lstat(file, options);
    });
    health.mockImplementation(async () => {
      expect(healthy).toBe(true);
      return { status: "ok", models: ["zeta-2.1", "qwen2.5-coder-7b-instruct"] };
    });

    await manager().ensureReady();
    expect(processes.spawn).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledOnce();
    expect(processes.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootstrap",
      `gui/${process.getuid!()}`,
      expect.stringContaining("com.nesweep.local-models.plist"),
    ]);
  });

  test("provisions the bundled local socket endpoint", async () => {
    await manager().ensureReady();
    expect(health).toHaveBeenCalled();
    expect(manager().socketPath).toBe(
      getLocalRuntimeSocketPath(path.join(storage, "local-models")),
    );
    expect(processes.spawn).toHaveBeenCalledOnce();
    expect(processes.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootstrap",
      `gui/${process.getuid!()}`,
      expect.stringContaining("com.nesweep.local-models.plist"),
    ]);
    await expect(fs.stat(path.join(storage, "local-models", "sources"))).resolves.toBeDefined();
  });

  test.each(["0", "2000"])(
    "reuses a healthy dual-model server with residency interval %s without restarting",
    async (interval) => {
      vi.stubEnv("MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS", interval);
      healthy = true;
      await manager().ensureReady();
      expect(health).toHaveBeenCalledOnce();
      expect(processes.execute).not.toHaveBeenCalled();
      expect(processes.spawn).not.toHaveBeenCalled();
      await expect(fs.stat(storage)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test.each([undefined, "0", "2500", "bad&<value>"])(
    "serializes the inherited residency interval %s in the LaunchAgent environment",
    async (interval) => {
      vi.stubEnv("MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS", interval);
      await manager().ensureReady();
      const plist = await fs.readFile(
        path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist"),
        "utf8",
      );
      const key = "<key>MLX_METAL_RESIDENCY_REFRESH_INTERVAL_MS</key>";
      const escaped = (interval ?? "1000")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      expect(plist).toContain(`${key}<string>${escaped}</string>`);
    },
  );

  test("disposal during the initial health check prevents provisioning after it resolves", async () => {
    const dispose = vi.spyOn(CompletionClient.prototype, "dispose");
    let finishHealth!: (response: unknown) => void;
    let startedHealth!: () => void;
    const checkingHealth = new Promise<void>((resolve) => {
      startedHealth = resolve;
    });
    health.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          finishHealth = resolve;
          startedHealth();
        }),
    );
    const server = manager();
    const ready = server.ensureReady();
    await checkingHealth;
    expect(health).toHaveBeenCalledOnce();

    const signal = health.mock.calls[0]![0]!;
    expect(signal.aborted).toBe(false);
    server.dispose();
    expect(signal.aborted).toBe(true);
    finishHealth({ status: "starting", models: [] });

    await expect(ready).rejects.toThrow(/disposed|cancelled/i);
    expect(window.withProgress).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(processes.execute).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(fs.stat(storage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("disposes temporary health clients after a failed probe and successful retry", async () => {
    const dispose = vi.spyOn(CompletionClient.prototype, "dispose");
    health.mockRejectedValueOnce(new Error("temporary health failure"));

    await manager().ensureReady();

    expect(health.mock.calls.length).toBeGreaterThan(1);
    expect(dispose).toHaveBeenCalledTimes(health.mock.calls.length);
  });

  test("stages only bundled helpers and starts an isolated, escaped LaunchAgent", async () => {
    await manager().ensureReady();
    const root = path.join(storage, "local-models");
    const versions = await fs.readdir(path.join(root, "sources"));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatch(/^[a-f0-9]{64}$/);
    const source = path.join(root, "sources", versions[0]!);
    expect((await fs.readdir(source, { recursive: true })).sort()).toEqual(
      [...BUNDLED_FILES, "src", "src/proto", ".complete"].sort(),
    );
    for (const manifest of ["pyproject.toml", "uv.lock", ".python-version"]) {
      await expect(fs.readFile(path.join(source, manifest), "utf8")).resolves.toBe(
        `fixture ${manifest}\n`,
      );
    }
    await expect(fs.readFile(path.join(source, "src", "server.py"), "utf8")).resolves.toBe(
      "fixture src/server.py\n",
    );
    expect(processes.spawn).toHaveBeenCalledExactlyOnceWith(
      "/opt/homebrew/bin/uv",
      ["sync", "--locked", "--project", source, "--no-dev"],
      expect.objectContaining({
        env: expect.objectContaining({
          UV_PROJECT_ENVIRONMENT: path.join(root, "environment"),
          HF_HOME: path.join(root, "huggingface"),
        }),
      }),
    );
    const plist = await fs.readFile(
      path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist"),
      "utf8",
    );
    expect(plist).toContain("storage &amp; &lt;models&gt;");
    expect(plist).toContain("/environment/bin/python</string>");
    expect(plist).toContain("<string>--socket-path</string>");
    expect(plist).not.toContain("<string>--port</string>");
    const args = await installedProgramArguments();
    expect(args.slice(1, 4)).toEqual([
      path.join(source, "src", "server.py"),
      "--socket-path",
      getLocalRuntimeSocketPath(root),
    ]);
    expect(args.slice(4, 7)).toEqual([
      "--status-file",
      path.join(root, "setup-status.json"),
      "--setup-id",
    ]);
    expect(args[7]).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    );
    expect(plist).not.toContain("extension &");
    expect(processes.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootstrap",
      `gui/${process.getuid!()}`,
      expect.stringContaining("com.nesweep.local-models.plist"),
    ]);
    await expect(fs.stat(path.join(root, "setup.lock.released"))).resolves.toBeDefined();
  });

  test("discovers nested runtime files while excluding checkout and bytecode artifacts", async () => {
    const bundled = path.join(extension, "tools", "zeta-server");
    const ignored = [
      "run.sh",
      "README.md",
      "tests/test_server.py",
      "weights/model.safetensors",
      "src/__pycache__/server.cpython-313.pyc",
      "src/__pycache__/accidental.py",
      "src/nested/cached.pyc",
      "src/nested/cached.pyo",
    ];
    for (const name of [...ignored, "src/nested/new_runtime.py"]) {
      const file = path.join(bundled, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `fixture ${name}\n`);
    }
    await manager().ensureReady();
    const source = processes.spawn.mock.calls[0]![1][3] as string;
    await expect(fs.readFile(path.join(source, "src/nested/new_runtime.py"), "utf8")).resolves.toBe(
      "fixture src/nested/new_runtime.py\n",
    );
    for (const name of [...ignored, ".venv/not-bundled"]) {
      await expect(fs.stat(path.join(source, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("hashes nested runtime paths and bytes deterministically", async () => {
    const bundled = path.join(extension, "tools", "zeta-server", "src");
    await fs.mkdir(path.join(bundled, "nested"));
    const first = path.join(bundled, "nested", "first.py");
    const second = path.join(bundled, "nested", "second.py");
    await fs.writeFile(first, "first contents");
    await fs.writeFile(second, "second contents");
    const stage = async () => {
      healthy = false;
      await fs.rm(
        path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist"),
        { force: true },
      );
      await manager().ensureReady();
      return processes.spawn.mock.calls.at(-1)![1][3] as string;
    };
    const original = await stage();
    await fs.unlink(first);
    await fs.unlink(second);
    await fs.writeFile(second, "second contents");
    await fs.writeFile(first, "first contents");
    expect(await stage()).toBe(original);
    await fs.rename(first, path.join(bundled, "nested", "renamed.py"));
    const renamed = await stage();
    expect(renamed).not.toBe(original);
    await fs.writeFile(path.join(bundled, "nested", "renamed.py"), "updated contents");
    const changedSource = await stage();
    expect(changedSource).not.toBe(renamed);
    await fs.writeFile(
      path.join(extension, "tools", "zeta-server", "pyproject.toml"),
      "updated dependencies\n",
    );
    const changedManifest = await stage();
    expect(changedManifest).not.toBe(changedSource);
    await fs.writeFile(path.join(extension, "tools", "zeta-server", "uv.lock"), "updated lock\n");
    expect(await stage()).not.toBe(changedManifest);
    await expect(fs.readFile(path.join(original, "src/nested/first.py"), "utf8")).resolves.toBe(
      "first contents",
    );
  });

  test.each(["file", "directory", "source root", "manifest"])(
    "rejects an external symlink at the bundled %s before runtime or service mutation",
    async (kind) => {
      const bundled = path.join(extension, "tools", "zeta-server");
      const outside = path.join(temporary, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "escaped.py"), "outside runtime");
      let link = path.join(bundled, "src", "escaped.py");
      let target = path.join(outside, "escaped.py");
      if (kind === "directory") {
        link = path.join(bundled, "src", "external");
        target = outside;
      } else if (kind === "source root") {
        link = path.join(bundled, "src");
        await fs.rm(link, { recursive: true });
        target = outside;
      } else if (kind === "manifest") {
        link = path.join(bundled, "pyproject.toml");
        await fs.unlink(link);
      }
      await fs.symlink(target, link);
      await expect(manager().ensureReady()).rejects.toThrow(/Bundled helper.*plain/);
      expect(processes.spawn).not.toHaveBeenCalled();
      expect(
        processes.execute.mock.calls.some(([, args]) => ["bootout", "bootstrap"].includes(args[0])),
      ).toBe(false);
    },
  );

  test("shares one in-flight provisioning attempt between concurrent callers", async () => {
    const server = manager();
    const first = server.ensureReady();
    expect(server.ensureReady()).toBe(first);
    await first;
    expect(processes.spawn).toHaveBeenCalledOnce();
    await server.ensureReady();
    expect(processes.spawn).toHaveBeenCalledOnce();
  });

  test("reports measured downloads then loading, and waits for both healthy models", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reports: string[] = [];
    const notices = new Map<string, () => void>();
    function reported(fragment: string): Promise<void> {
      return new Promise<void>((resolve) => {
        notices.set(fragment, resolve);
      });
    }
    const downloaded = reported("MB/s");
    const loadedQwen = reported("Qwen (2/2): Loading model into memory");
    const checkingHealth = reported("checking both local model health IDs");
    vi.mocked(window.withProgress).mockImplementationOnce(async (_options, task) =>
      task(
        {
          report: ({ message }) => {
            reports.push(message!);
            for (const [fragment, resolve] of notices) {
              if (message?.includes(fragment)) resolve();
            }
          },
        },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) },
      ),
    );
    let started = false;
    processes.execute.mockImplementation(async (_command, args: string[]) => {
      if (args[0] === "print") throw Object.assign(new Error("missing"), { code: 113 });
      if (args[0] === "bootstrap") {
        started = true;
        await publishSetupStatus({
          downloaded_bytes: 5_000_000,
          total_bytes: 12_500_000,
          total_bytes_estimated: true,
          speed_bytes_per_second: 1_000_000,
          reconstructed_bytes: 300_000,
          reconstruction_total_bytes: 10_000_000,
        });
      }
      return { stdout: "", stderr: "" };
    });
    health.mockImplementation(async () => ({
      status: started ? "ok" : "starting",
      models: healthy ? ["zeta-2.1", "qwen2.5-coder-7b-instruct"] : ["zeta-2.1"],
    }));
    const ready = manager().ensureReady();
    await downloaded;
    expect(reports).toContain("Zeta (1/2): Downloading ~40% (1.0 MB/s) · Assembling 3%");
    expect(reports.join("\n")).not.toContain("Both local models are ready");
    await publishSetupStatus({ stage: "loading", model: "Qwen", model_index: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    await loadedQwen;
    expect(reports.join("\n")).toMatch(/Qwen.*Loading model into memory/);
    await publishSetupStatus({ stage: "ready" });
    await vi.advanceTimersByTimeAsync(1000);
    await checkingHealth;
    expect(reports.join("\n")).toMatch(/checking both local model health IDs/);
    expect(reports.join("\n")).not.toContain("Both local models are ready");
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    await ready;
    expect(reports.at(-1)).toBe("Both local models are ready.");
  });

  test("surfaces a matching setup error immediately instead of waiting thirty minutes", async () => {
    let started = false;
    processes.execute.mockImplementation(async (_command, args: string[]) => {
      if (args[0] === "print") {
        if (!started) throw Object.assign(new Error("missing"), { code: 113 });
        const program = await installedProgramArguments();
        return { stdout: `program = ${program[0]}\n${program.join("\n")}`, stderr: "" };
      }
      if (args[0] === "-convert")
        return {
          stdout: JSON.stringify({
            Label: "com.nesweep.local-models",
            NESweepStorageRoot: path.join(storage, "local-models"),
            ProgramArguments: await installedProgramArguments(),
          }),
          stderr: "",
        };
      if (args[0] === "bootstrap") {
        started = true;
        await publishSetupStatus({ stage: "error", message: "Model download failed: disk full." });
      }
      if (args[0] === "bootout") started = false;
      return { stdout: "", stderr: "" };
    });
    await expect(manager().ensureReady()).rejects.toThrow("Model download failed: disk full.");
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
      "Show Output",
    );
    await expect(
      fs.stat(path.join(storage, "local-models", "setup.lock.released")),
    ).resolves.toBeDefined();
    expect(processes.execute).toHaveBeenCalledWith("/bin/launchctl", [
      "bootout",
      `gui/${process.getuid!()}/com.nesweep.local-models`,
    ]);
    await expect(
      fs.stat(path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each(["missing", "malformed", "oversized", "old session", "stale"])(
    "falls back to health checks for %s telemetry",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let fallback!: () => void;
      const reportedFallback = new Promise<void>((resolve) => {
        fallback = resolve;
      });
      const reports: string[] = [];
      vi.mocked(window.withProgress).mockImplementationOnce(async (_options, task) =>
        task(
          {
            report: ({ message }) => {
              reports.push(message!);
              if (message?.includes("Waiting for local model startup")) fallback();
            },
          },
          { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) },
        ),
      );
      processes.execute.mockImplementation(async (_command, args: string[]) => {
        if (args[0] === "print") throw Object.assign(new Error("missing"), { code: 113 });
        if (args[0] === "bootstrap" && kind !== "missing") {
          const statusFile = path.join(storage, "local-models", "setup-status.json");
          if (kind === "malformed") await fs.writeFile(statusFile, "{");
          else
            await publishSetupStatus({
              stage: "error",
              message: "This error belongs to ignored telemetry",
              ...(kind === "old session"
                ? { setup_id: "e8277f5b-a7b4-4b15-b57a-f478b41536df" }
                : {}),
              ...(kind === "stale" ? { updated_at: Date.now() / 1000 - 60 } : {}),
              ...(kind === "oversized" ? { padding: "x".repeat(17_000) } : {}),
            });
        }
        return { stdout: "", stderr: "" };
      });
      const ready = manager().ensureReady();
      await reportedFallback;
      expect(reports.join("\n")).not.toContain("This error belongs");
      healthy = true;
      await vi.advanceTimersByTimeAsync(1000);
      await ready;
    },
  );

  test.each(["orphaned recovery", "empty setup lock"])(
    "advances past an old %s without deleting its ownership artifact",
    async (artifact) => {
      const root = path.join(storage, "local-models");
      const lock = path.join(root, "setup.lock");
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        lock,
        artifact === "empty setup lock" ? "" : JSON.stringify({ pid: 999999, token: "dead-setup" }),
      );
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(lock, old, old);
      if (artifact === "orphaned recovery") {
        await fs.writeFile(
          `${lock}.recovery`,
          JSON.stringify({ pid: 999999, token: "dead-recovery" }),
        );
        await fs.utimes(`${lock}.recovery`, old, old);
      }
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        expect(signal).toBe(0);
        if (pid === 999999) throw Object.assign(new Error("dead process"), { code: "ESRCH" });
        return true;
      });
      const original = await fs.readFile(lock, "utf8");
      await manager().ensureReady();
      await manager().ensureReady();

      expect(processes.spawn).toHaveBeenCalledOnce();
      expect(
        processes.execute.mock.calls.filter(([, args]) => args[0] === "bootstrap"),
      ).toHaveLength(1);
      await expect(fs.readFile(lock, "utf8")).resolves.toBe(original);
      await expect(fs.stat(`${lock}.1.released`)).resolves.toBeDefined();
      if (artifact === "orphaned recovery") {
        await expect(fs.readFile(`${lock}.recovery`, "utf8")).resolves.toContain("dead-recovery");
      }
    },
  );

  test("preserves a live owner's lock until its provisioning completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let installed!: () => void;
    const installing = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    processes.spawn.mockImplementationOnce(() => {
      installed();
      return child;
    });
    const first = manager().ensureReady();
    await installing;
    const lock = path.join(storage, "local-models", "setup.lock");
    const owner = await fs.readFile(lock, "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const waiting = nextSetupReport();
    const second = manager().ensureReady();
    await waiting;

    await expect(fs.readFile(lock, "utf8")).resolves.toBe(owner);
    expect(processes.spawn).toHaveBeenCalledOnce();
    expect(processes.execute.mock.calls.some(([, args]) => args[0] === "bootstrap")).toBe(false);

    child.emit("close", 0);
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(processes.spawn).toHaveBeenCalledOnce();
    expect(processes.execute.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(
      1,
    );
    await expect(fs.readFile(lock, "utf8")).resolves.toBe(owner);
    await expect(fs.stat(`${lock}.released`)).resolves.toBeDefined();
  });

  test("a paused stale contender preserves a concurrently published live generation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = path.join(storage, "local-models");
    const lock = path.join(root, "setup.lock");
    const next = `${lock}.1`;
    const staleOwner = JSON.stringify({ pid: 999999, token: "stale-generation" });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(lock, staleOwner);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 999999) throw Object.assign(new Error("dead process"), { code: "ESRCH" });
      return true;
    });

    let reachedPublication!: () => void;
    let resumePublication!: () => void;
    const publishing = new Promise<void>((resolve) => {
      reachedPublication = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumePublication = resolve;
    });
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let paused = false;
    vi.mocked(fs.link).mockImplementation(async (source, destination) => {
      if (destination === next && !paused) {
        paused = true;
        reachedPublication();
        await resume;
      }
      return actualFs.link(source, destination);
    });
    const waiting = nextSetupReport();
    const first = manager().ensureReady();
    await publishing;

    let reachedInstall!: () => void;
    const installing = new Promise<void>((resolve) => {
      reachedInstall = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    processes.spawn.mockImplementationOnce(() => {
      reachedInstall();
      return child;
    });
    const second = manager().ensureReady();
    await installing;
    const liveOwner = await fs.readFile(next, "utf8");
    expect(JSON.parse(liveOwner)).toMatchObject({ pid: process.pid, token: expect.any(String) });

    resumePublication();
    await waiting;
    await expect(fs.readFile(next, "utf8")).resolves.toBe(liveOwner);
    await expect(fs.readFile(lock, "utf8")).resolves.toBe(staleOwner);
    await expect(fs.stat(`${lock}.2`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(processes.spawn).toHaveBeenCalledOnce();

    child.emit("close", 0);
    await second;
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    await expect(fs.readFile(next, "utf8")).resolves.toBe(liveOwner);
    await expect(fs.stat(`${next}.released`)).resolves.toBeDefined();
    expect(processes.spawn).toHaveBeenCalledOnce();
    expect(processes.execute.mock.calls.filter(([, args]) => args[0] === "bootstrap")).toHaveLength(
      1,
    );
  });

  test("restages changed bundled helpers without overwriting old sources or persistent caches", async () => {
    await manager().ensureReady();
    const root = path.join(storage, "local-models");
    const [oldVersion] = await fs.readdir(path.join(root, "sources"));
    await fs.mkdir(path.join(root, "huggingface"), { recursive: true });
    await fs.writeFile(path.join(root, "huggingface", "checkpoint"), "cached model");
    await fs.writeFile(
      path.join(extension, "tools", "zeta-server", "src", "server.py"),
      "updated server\n",
    );
    await fs.unlink(
      path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist"),
    );
    healthy = false;

    await manager().ensureReady();

    const versions = await fs.readdir(path.join(root, "sources"));
    expect(versions).toHaveLength(2);
    const newVersion = versions.find((version) => version !== oldVersion)!;
    await expect(
      fs.readFile(path.join(root, "sources", oldVersion!, "src", "server.py"), "utf8"),
    ).resolves.toBe("fixture src/server.py\n");
    await expect(
      fs.readFile(path.join(root, "sources", newVersion, "src", "server.py"), "utf8"),
    ).resolves.toBe("updated server\n");
    await expect(fs.readFile(path.join(root, "huggingface", "checkpoint"), "utf8")).resolves.toBe(
      "cached model",
    );
  });

  test("cancellation before startup does not stop an existing service", async () => {
    vi.mocked(window.withProgress).mockImplementationOnce(async (_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: true,
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
      ),
    );
    await expect(manager().ensureReady()).rejects.toThrow(/cancelled/);
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(processes.execute).not.toHaveBeenCalled();
  });

  test("keeps a cancelled setup latched until an explicit retry", async () => {
    vi.mocked(window.withProgress).mockImplementationOnce(async (_options, task) =>
      task(
        { report: vi.fn() },
        {
          isCancellationRequested: true,
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
      ),
    );
    const server = manager();
    await expect(server.ensureReady()).rejects.toThrow(/cancelled/);
    const progressCalls = vi.mocked(window.withProgress).mock.calls.length;
    await expect(server.ensureReady()).rejects.toThrow(/cancelled/);
    expect(window.withProgress).toHaveBeenCalledTimes(progressCalls);
    await expect(server.ensureReady(true)).resolves.toBeUndefined();
    expect(processes.spawn).toHaveBeenCalledOnce();
  });

  test.each(["removed", "replacement", "timeout", "cancellation"])(
    "waits for the current service to stop before updating: %s",
    async (transition) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const root = path.join(storage, "local-models");
      const plist = path.join(
        temporary,
        "Library",
        "LaunchAgents",
        "com.nesweep.local-models.plist",
      );
      await fs.mkdir(path.dirname(plist), { recursive: true });
      await fs.writeFile(plist, "current registration");
      const previous = currentProgramArguments(root);
      let stopping = false;
      let polls = 0;
      let unloaded = false;
      let reachedPoll!: () => void;
      const polling = new Promise<void>((resolve) => {
        reachedPoll = resolve;
      });
      processes.execute.mockImplementation(async (_command, args: string[]) => {
        if (args[0] === "-convert")
          return {
            stdout: JSON.stringify({
              Label: "com.nesweep.local-models",
              NESweepStorageRoot: root,
              ProgramArguments: previous,
            }),
            stderr: "",
          };
        if (args[0] === "bootout") stopping = true;
        if (args[0] === "print") {
          if (stopping) {
            polls++;
            if (transition === "removed" && polls >= 3) {
              unloaded = true;
              throw Object.assign(new Error("missing"), { code: 113 });
            }
            reachedPoll();
            if (transition === "replacement" && polls >= 2)
              return { stdout: "program = /unrelated/python", stderr: "" };
          }
          return { stdout: `program = ${previous[0]}\n${previous.join("\n")}`, stderr: "" };
        }
        if (args[0] === "bootstrap") {
          expect(unloaded).toBe(true);
          healthy = true;
        }
        return { stdout: "", stderr: "" };
      });
      const ready = manager().ensureReady();
      const result =
        transition === "removed"
          ? expect(ready).resolves.toBeUndefined()
          : expect(ready).rejects.toThrow(
              transition === "replacement"
                ? /Refusing to stop/
                : transition === "timeout"
                  ? /did not finish stopping/
                  : /cancelled/,
            );
      await polling;
      expect(processes.execute.mock.calls.some(([, args]) => args[0] === "bootstrap")).toBe(false);
      await expect(fs.readFile(plist, "utf8")).resolves.toBe("current registration");
      await expect(fs.stat(path.join(root, "setup.lock.released"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (transition === "cancellation") cancel!();
      else await vi.advanceTimersByTimeAsync(transition === "timeout" ? 30_000 : 200);
      await result;
      expect(processes.execute.mock.calls.filter(([, args]) => args[0] === "bootout")).toHaveLength(
        1,
      );
      if (transition !== "removed") {
        expect(processes.execute.mock.calls.some(([, args]) => args[0] === "bootstrap")).toBe(
          false,
        );
        await expect(fs.readFile(plist, "utf8")).resolves.toBe("current registration");
      }
    },
  );

  test.each([
    { cause: "bootstrap failure", transition: "removed" },
    { cause: "bootstrap failure", transition: "replacement service" },
    { cause: "bootstrap failure", transition: "replacement plist" },
    { cause: "bootstrap failure", transition: "timeout" },
    { cause: "cancellation", transition: "removed" },
  ])("preserves $cause while cleanup waits for $transition", async ({ cause, transition }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    output.error.mockClear();
    const failure = new Error("bootstrap failed: input/output error");
    const root = path.join(storage, "local-models");
    const plist = path.join(temporary, "Library", "LaunchAgents", "com.nesweep.local-models.plist");
    let launched = false;
    let stopping = false;
    let polls = 0;
    let program: string[] = [];
    let reachedPoll!: () => void;
    const polling = new Promise<void>((resolve) => {
      reachedPoll = resolve;
    });
    processes.execute.mockImplementation(async (_command, args: string[]) => {
      if (args[0] === "-convert")
        return {
          stdout: JSON.stringify({
            Label: "com.nesweep.local-models",
            NESweepStorageRoot: root,
            ProgramArguments:
              transition === "replacement plist" && polls >= 2
                ? [...program.slice(0, 7), "c08fdc0e-a3b6-4873-977b-588b89033fba"]
                : program,
          }),
          stderr: "",
        };
      if (args[0] === "bootstrap") {
        program = await installedProgramArguments();
        launched = true;
        if (cause === "cancellation") cancel!();
        else throw failure;
      }
      if (args[0] === "bootout") stopping = true;
      if (args[0] === "print") {
        if (!launched) throw Object.assign(new Error("missing"), { code: 113 });
        if (stopping) {
          polls++;
          reachedPoll();
          if (polls >= 2 && transition === "replacement service") {
            await fs.writeFile(plist, "replacement registration");
            return { stdout: "program = /unrelated/python", stderr: "" };
          }
          if (polls >= 2 && transition !== "timeout") {
            if (transition === "replacement plist")
              await fs.writeFile(plist, "replacement registration");
            throw Object.assign(new Error("missing"), { code: 113 });
          }
        }
        return { stdout: `program = ${program[0]}\n${program.join("\n")}`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const ready = manager().ensureReady();
    const result =
      cause === "cancellation"
        ? expect(ready).rejects.toThrow(/cancelled/)
        : expect(ready).rejects.toBe(failure);
    await polling;
    await expect(fs.stat(path.join(root, "setup.lock.released"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(plist, "utf8")).resolves.toContain("RunAtLoad");
    await vi.advanceTimersByTimeAsync(transition === "timeout" ? 30_000 : 100);
    await result;
    await expect(fs.stat(path.join(root, "setup.lock.released"))).resolves.toBeDefined();
    if (transition.startsWith("replacement"))
      await expect(fs.readFile(plist, "utf8")).resolves.toBe("replacement registration");
    else if (transition === "removed")
      await expect(fs.stat(plist)).rejects.toMatchObject({ code: "ENOENT" });
    else await expect(fs.readFile(plist, "utf8")).resolves.toContain("RunAtLoad");
    if (transition === "replacement service" || transition === "timeout")
      expect(output.error).toHaveBeenCalledWith(
        "Failed to clean up the managed local model startup",
        expect.any(Error),
      );
  });

  test.each(["../server.py", "src/other.py", "src/server.py/extra", "src/../../server.py"])(
    "preserves an unrecognized entry path %s",
    async (entry) => {
      const root = path.join(storage, "local-models");
      const plist = path.join(
        temporary,
        "Library",
        "LaunchAgents",
        "com.nesweep.local-models.plist",
      );
      await fs.mkdir(path.dirname(plist), { recursive: true });
      await fs.writeFile(plist, "unrecognized registration");
      processes.execute.mockImplementation(async (_command, args: string[]) => ({
        stdout:
          args[0] === "-convert"
            ? JSON.stringify({
                Label: "com.nesweep.local-models",
                NESweepStorageRoot: root,
                ProgramArguments: currentProgramArguments(root, entry),
              })
            : "",
        stderr: "",
      }));
      await expect(manager().ensureReady()).rejects.toThrow(/unrecognized LaunchAgent/);
      expect(processes.spawn).not.toHaveBeenCalled();
      expect(
        processes.execute.mock.calls.some(([, args]) => ["bootout", "bootstrap"].includes(args[0])),
      ).toBe(false);
      await expect(fs.readFile(plist, "utf8")).resolves.toBe("unrecognized registration");
    },
  );

  test.each(["storage root", "socket path", "socket user", "custom arguments", "symlink plist"])(
    "preserves an existing service with mismatched %s",
    async (mismatch) => {
      const root = path.join(storage, "local-models");
      const plist = path.join(
        temporary,
        "Library",
        "LaunchAgents",
        "com.nesweep.local-models.plist",
      );
      await fs.mkdir(path.dirname(plist), { recursive: true });
      const contents = "unowned registration";
      if (mismatch === "symlink plist") {
        const target = path.join(temporary, "custom.plist");
        await fs.writeFile(target, contents);
        await fs.symlink(target, plist);
      } else await fs.writeFile(plist, contents);
      const socketPath = getLocalRuntimeSocketPath(root);
      const program = [
        path.join(root, "environment/bin/python"),
        path.join(root, "sources", "a".repeat(64), "src/server.py"),
        "--socket-path",
        mismatch === "socket path"
          ? `${socketPath}.other`
          : mismatch === "socket user"
            ? getLocalRuntimeSocketPath(root, process.getuid!() + 1)
            : socketPath,
        "--status-file",
        path.join(root, "setup-status.json"),
        "--setup-id",
        "67ff8c7c-8ab2-4cec-8d5c-a491bc888038",
        ...(mismatch === "custom arguments" ? ["--unexpected-option", "value"] : []),
      ];
      processes.execute.mockImplementation(async (_command, args: string[]) => ({
        stdout:
          args[0] === "-convert"
            ? JSON.stringify({
                Label: "com.nesweep.local-models",
                NESweepStorageRoot:
                  mismatch === "storage root" ? path.join(temporary, "other") : root,
                ProgramArguments: program,
              })
            : args[0] === "print"
              ? `program = ${program[0]}\n${program.join("\n")}`
              : "",
        stderr: "",
      }));

      await expect(manager().ensureReady()).rejects.toThrow(/LaunchAgent|symlink/i);
      expect(processes.spawn).not.toHaveBeenCalled();
      expect(
        processes.execute.mock.calls.some(([, args]) => ["bootout", "bootstrap"].includes(args[0])),
      ).toBe(false);
      await expect(fs.readFile(plist, "utf8")).resolves.toBe(contents);
      if (mismatch === "symlink plist") expect((await fs.lstat(plist)).isSymbolicLink()).toBe(true);
    },
  );

  test("refuses a loaded service lacking matching ownership metadata", async () => {
    processes.execute.mockImplementation(async (_command, args: string[]) => ({
      stdout: args[0] === "print" ? "program = /unrelated/python" : "",
      stderr: "",
    }));
    await expect(manager().ensureReady()).rejects.toThrow(/without NESweep ownership metadata/);
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(
      processes.execute.mock.calls.some(
        ([, args]) => args[0] === "bootout" || args[0] === "bootstrap",
      ),
    ).toBe(false);
  });

  test.each([
    { cause: "cancellation", matching: true },
    { cause: "cancellation", matching: false },
    { cause: "timeout", matching: true },
    { cause: "timeout", matching: false },
  ])(
    "cleans up $cause only for the matching owned service (matching=$matching)",
    async ({ cause, matching }) => {
      let started = false;
      let stopped = false;
      const root = path.join(storage, "local-models");
      const plist = path.join(
        temporary,
        "Library",
        "LaunchAgents",
        "com.nesweep.local-models.plist",
      );
      const checkpoint = path.join(root, "huggingface", "checkpoint");
      await fs.mkdir(path.dirname(checkpoint), { recursive: true });
      await fs.writeFile(checkpoint, "cached model");
      if (cause === "timeout") {
        let now = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        health.mockImplementation(async () => {
          if (started) now = 31 * 60_000;
          return { status: "starting", models: [] };
        });
      }
      processes.execute.mockImplementation(async (_command, args: string[]) => {
        const program = started ? await installedProgramArguments() : [];
        if (args[0] === "print") {
          if (!started || stopped) throw Object.assign(new Error("missing"), { code: 113 });
          return {
            stdout: matching
              ? `program = ${program[0]}\n${program.join("\n")}`
              : "program = /unrelated/python",
            stderr: "",
          };
        }
        if (args[0] === "-convert")
          return {
            stdout: JSON.stringify({
              Label: "com.nesweep.local-models",
              NESweepStorageRoot: root,
              ProgramArguments: program,
            }),
            stderr: "",
          };
        if (args[0] === "bootstrap") {
          started = true;
          if (cause === "cancellation") cancel!();
        }
        if (args[0] === "bootout") stopped = true;
        return { stdout: "", stderr: "" };
      });

      await expect(manager().ensureReady()).rejects.toThrow(
        cause === "cancellation" ? /cancelled/ : /did not become ready within 30 minutes/,
      );
      const bootouts = processes.execute.mock.calls.filter(([, args]) => args[0] === "bootout");
      expect(bootouts).toEqual(
        matching
          ? [["/bin/launchctl", ["bootout", `gui/${process.getuid!()}/com.nesweep.local-models`]]]
          : [],
      );
      await expect(fs.stat(path.join(root, "setup.lock.released"))).resolves.toBeDefined();
      if (matching) await expect(fs.stat(plist)).rejects.toMatchObject({ code: "ENOENT" });
      else await expect(fs.readFile(plist, "utf8")).resolves.toContain("RunAtLoad");
      await expect(fs.readFile(checkpoint, "utf8")).resolves.toBe("cached model");
    },
  );
});

describe("uv discovery", () => {
  test("finds Homebrew uv when the Extension Host PATH omits it", async () => {
    await expect(findUv()).resolves.toBe("/opt/homebrew/bin/uv");
    expect(processes.execute).toHaveBeenCalledWith("/opt/homebrew/bin/uv", ["--version"], {
      timeout: 5000,
    });
  });

  test("gives an actionable installation instruction when uv is absent", async () => {
    vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(findUv()).rejects.toThrow(
      /Install uv from https:\/\/docs\.astral\.sh\/uv\/getting-started\/installation\//,
    );
    expect(processes.execute).not.toHaveBeenCalled();
  });
});

describe("managed local server health", () => {
  test("requires both bundled model identities", () => {
    expect(
      hasExpectedManagedModels({ status: "ok", models: ["unrelated-model", "another-model"] }),
    ).toBe(false);
    expect(
      hasExpectedManagedModels({
        status: "ok",
        models: ["zeta-2.1", "qwen2.5-coder-7b-instruct"],
      }),
    ).toBe(true);
  });

  test.each([
    undefined,
    null,
    {},
    { status: "ok", model: "zeta-2.1" },
    { status: "ok", models: ["zeta-2.1"] },
    { status: "ok", models: ["qwen2.5-coder-7b-instruct"] },
    { status: "ok", models: ["zeta-2.1", "unrelated-model"] },
    { status: "starting", models: ["zeta-2.1", "qwen2.5-coder-7b-instruct"] },
    { status: "ok", models: "zeta-2.1,qwen2.5-coder-7b-instruct" },
  ])("rejects an incomplete or malformed health response: %j", (health) => {
    expect(hasExpectedManagedModels(health)).toBe(false);
  });
});
