import * as vscode from "vscode";
import { config } from "~/core/config";

let proposalAvailable = false;

export function isInlineEditProposalAvailable(): boolean {
  return proposalAvailable;
}

export function registerInlineCompletionItemProviderWithMetadata(
  selector: vscode.DocumentSelector,
  provider: vscode.InlineCompletionItemProvider,
  metadata: {
    groupId?: string;
    debounceDelayMs?: number;
    displayName?: string;
    excludes?: string[];
    yieldTo?: string[];
  },
): vscode.Disposable {
  const register = vscode.languages.registerInlineCompletionItemProvider as unknown as (
    selector: vscode.DocumentSelector,
    provider: vscode.InlineCompletionItemProvider,
    metadata?: unknown,
  ) => vscode.Disposable;
  if (!config.useCopilotStyleNextEditPresentation) {
    proposalAvailable = false;
    return register(selector, provider);
  }
  try {
    const registration = register(selector, provider, metadata);
    proposalAvailable = true;
    return registration;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/inlineCompletionsAdditions/i.test(message) ||
      !/(proposed|proposal)/i.test(message) ||
      !/(enable|allow|available|denied|not supported)/i.test(message)
    )
      throw error;
    proposalAvailable = false;
    return register(selector, provider);
  }
}

export function markAsProposedInlineEdit(
  item: vscode.InlineCompletionItem,
  options: {
    showRange?: vscode.Range;
    displayLocation?: { range: vscode.Range; kind: 1 | 2; label: string };
    correlationId: string;
  },
): vscode.InlineCompletionItem {
  Object.assign(item, {
    isInlineEdit: true,
    showInlineEditMenu: true,
    correlationId: options.correlationId,
  });
  if (options.showRange) Object.assign(item, { showRange: options.showRange });
  if (options.displayLocation) Object.assign(item, { displayLocation: options.displayLocation });
  return item;
}

export function enableForwardStability(
  list: vscode.InlineCompletionList,
): vscode.InlineCompletionList {
  Object.assign(list, { enableForwardStability: true });
  return list;
}
