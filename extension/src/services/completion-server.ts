import * as vscode from "vscode";
import { CompletionClient } from "~/api/completion-client.ts";
import { logger } from "~/core/logger.ts";

export class CompletionServer implements vscode.Disposable {
  private client: CompletionClient | undefined;
  private failures = 0;
  private lastWarning = 0;
  constructor(
    private readonly socketPath: string,
    private readonly readiness?: (retry?: boolean) => Promise<void>,
  ) {}
  getClient(): CompletionClient {
    return (this.client ??= new CompletionClient({ socketPath: this.socketPath }));
  }
  async waitUntilReady(retry = false): Promise<void> {
    await this.readiness?.(retry);
  }
  async ensureReachable(): Promise<boolean> {
    try {
      await this.waitUntilReady(true);
    } catch (error) {
      logger.warn("Model setup failed", error);
      return false;
    }
    try {
      if (await this.getClient().ping()) return true;
    } catch (error) {
      logger.warn("Model ping failed", error);
    }
    this.warn();
    return false;
  }
  reportSuccess(): void {
    this.failures = 0;
    this.lastWarning = 0;
  }
  reportFailure(): void {
    if (++this.failures >= 3) {
      this.failures = 0;
      this.warn();
    }
  }
  private warn(): void {
    const now = Date.now();
    if (this.lastWarning && now - this.lastWarning < 60000) return;
    this.lastWarning = now;
    void vscode.window.showWarningMessage(
      "zetacode could not reach its local model. Check the zetacode output for details.",
    );
  }
  dispose(): void {
    this.client?.dispose();
    this.client = undefined;
  }
}
