import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_BOARD_FILE_NAME, boardFileTemplate, isBoardFile } from './core/store';
import { KanbanEditorProvider, VIEW_TYPE } from './editor';
import { readConfig } from './config';
import { disposeLog, log, logError } from './log';

export function activate(context: vscode.ExtensionContext): void {
  try {
    context.subscriptions.push(
      { dispose: disposeLog },
      vscode.window.registerCustomEditorProvider(
        VIEW_TYPE,
        new KanbanEditorProvider(context.extensionUri),
        {
          webviewOptions: { retainContextWhenHidden: true },
          supportsMultipleEditorsPerDocument: false,
        },
      ),
      vscode.commands.registerCommand('markdownKanban.openBoard', () => openBoard()),
      vscode.commands.registerCommand('markdownKanban.openAsText', () => openActiveAsText()),
      vscode.commands.registerCommand('markdownKanban.createBoardFile', () => createBoardFile()),
    );
    log('activated');
  } catch (error) {
    logError('activate', error);
    throw error;
  }
}

/** Opens the board editor for the active `*.kb.yaml`, or the single one in the workspace. */
async function openBoard(): Promise<void> {
  const boardFile = await resolveBoardFile();
  if (!boardFile) {
    const create = await vscode.window.showInformationMessage(
      'Markdown Kanban: no board file (*.kb.yaml) found. Create one to start tracking documents.',
      'Create Board File',
    );
    if (create) await createBoardFile();
    return;
  }
  await KanbanEditorProvider.open(boardFile);
}

async function openActiveAsText(): Promise<void> {
  const boardFile = await resolveBoardFile();
  if (boardFile) await KanbanEditorProvider.openAsText(boardFile);
}

async function resolveBoardFile(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file' && isBoardFile(active.document.uri.fsPath)) {
    return active.document.uri;
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '*.kb.{yaml,yml}'),
      '**/node_modules/**',
      20,
    );
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      const picked = await vscode.window.showQuickPick(
        found.map((uri) => ({
          label: nodePath.basename(uri.fsPath),
          description: uri.fsPath,
          uri,
        })),
        { title: 'Which board file?' },
      );
      return picked?.uri;
    }
  }
  return undefined;
}

async function createBoardFile(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Markdown Kanban: open a folder first.');
    return;
  }

  let folder = folders[0];
  if (folders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      folders.map((entry) => ({ label: entry.name, description: entry.uri.fsPath, folder: entry })),
      { title: 'Where should the board file live?' },
    );
    if (!picked) return;
    folder = picked.folder;
  }

  const uri = vscode.Uri.joinPath(folder.uri, DEFAULT_BOARD_FILE_NAME);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const lists = readConfig().lists.map((list) => list.tag);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(boardFileTemplate(lists), 'utf8'));
    log(`created ${uri.fsPath}`);
  }

  // Open in the board editor so the new file is immediately usable.
  await KanbanEditorProvider.open(uri);
}
