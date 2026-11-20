import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/** Diagnostics channel ("Output → Markdown Kanban"); created on first use. */
export function log(message: string): void {
  channel ??= vscode.window.createOutputChannel('Markdown Kanban');
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`ERROR ${context}: ${detail}`);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
