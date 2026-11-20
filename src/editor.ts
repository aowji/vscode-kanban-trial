import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
  buildBoardView,
  formatColumnEntry,
  resolveColumns,
  UNASSIGNED_COLUMN_ID,
  UNASSIGNED_COLUMN_TITLE,
  type BoardCardInput,
  type BoardView,
  type ParsedColumn,
} from './core/board';
import { scanWorkspace, toPosix } from './core/scan';
import {
  addBoardList,
  moveBoardList,
  normalizeCardPath,
  readBoard,
  removeBoardList,
  setCardTags,
  type StoreUpdate,
} from './core/store';
import { readConfig } from './config';
import { log, logError } from './log';

export const VIEW_TYPE = 'markdownKanban.board';
const REFRESH_DEBOUNCE_MS = 250;
const CONTEXT_KEY = 'markdownKanban.boardOpen';
const PLAIN_EDITOR = 'default';

export interface BoardState {
  view: BoardView;
  context: {
    /** Absolute path of the board file; also used to restore the panel. */
    boardFile: string;
    boardFileName: string;
    folderName: string;
    fileCount: number;
    truncated: boolean;
    storeError?: string;
    /** Board entries whose document no longer exists. */
    staleEntries: number;
    moveTargets: { id: string; title: string }[];
  };
}

interface FromWebviewMessage {
  type?: string;
  path?: string;
  columnId?: string | null;
  entry?: string;
  /** Insertion position for `addList`, and destination for `moveList`. */
  index?: number;
}

/**
 * Registers `*.kb.yaml` as a custom editor, so the board is the default way to
 * open a board file. Because it is a *text* custom editor, the same document can
 * still be edited as YAML via "Reopen Editor With…".
 */
export class KanbanEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = VIEW_TYPE;

  private readonly editors = new Set<KanbanEditor>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Opens (or reveals) the board editor for a board file. */
  static async open(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }

  /** Opens the board file in a plain text editor, e.g. to hand-edit the YAML. */
  static async openAsText(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, PLAIN_EDITOR);
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): void {
    const editor = new KanbanEditor(panel, this.extensionUri, document, () => {
      this.editors.delete(editor);
      void updateContext(this.editors.size > 0);
    });
    this.editors.add(editor);
    void updateContext(true);
    log(`board editor resolved for ${document.uri.fsPath}`);
  }

  refreshAll(): void {
    for (const editor of this.editors) void editor.refresh();
  }
}

async function updateContext(value: boolean): Promise<void> {
  try {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, value);
  } catch {
    // Not fatal: the context key only controls command palette visibility.
  }
}

class KanbanEditor {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly boardDir: string;
  private lastState: BoardState | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private refreshQueued = false;
  private applyingEdit = false;
  private disposed = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
    private readonly onDispose: () => void,
  ) {
    this.boardDir = nodePath.dirname(document.uri.fsPath);

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
    this.panel.webview.html = renderHtml(this.panel.webview, extensionUri);
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'board-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'board-dark.svg'),
    };

    this.panel.webview.onDidReceiveMessage(
      (message: FromWebviewMessage) => void this.onMessage(message),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.panel.onDidChangeViewState(
      (event) => {
        if (event.webviewPanel.visible) this.scheduleRefresh(0);
      },
      undefined,
      this.disposables,
    );

    // The board file itself: edits made here or in a text editor both refresh it.
    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (event.document.uri.toString() !== this.document.uri.toString()) return;
        if (this.applyingEdit) return;
        this.scheduleRefresh();
      },
      undefined,
      this.disposables,
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,markdown}');
    watcher.onDidChange(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidCreate(() => this.scheduleRefresh(), undefined, this.disposables);
    watcher.onDidDelete(() => this.scheduleRefresh(), undefined, this.disposables);
    this.disposables.push(watcher);

    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('markdownKanban')) this.scheduleRefresh(0);
      },
      undefined,
      this.disposables,
    );
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh(0), undefined, this.disposables);
  }

  private dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    this.onDispose();
    log(`board editor disposed (${this.document.uri.fsPath})`);
  }

  private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      this.post({ type: 'busy', busy: true });
      const state = await this.buildState();
      this.lastState = state;
      this.post({ type: 'state', state });
    } catch (error) {
      logError('refresh', error);
      this.post({ type: 'error', message: (error as Error).message });
    } finally {
      this.refreshing = false;
      this.post({ type: 'busy', busy: false });
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  private async buildState(): Promise<BoardState> {
    const config = readConfig();
    const store = readBoard(this.document.getText());
    const columns: ParsedColumn[] = resolveColumns(store.lists, config.columns);
    const scanned = await scanWorkspace(
      [{ label: nodePath.basename(this.boardDir), dir: this.boardDir }],
      {
        ignoredDirs: config.ignoredDirs,
        maxFiles: config.maxFiles,
        readText: readTextPreferringOpenDocuments,
      },
    );

    const cards: BoardCardInput[] = scanned.cards.map((card) => ({
      ...card,
      tags: store.tags.get(normalizeCardPath(card.relPath)) ?? [],
    }));

    const known = new Set(scanned.cards.map((card) => normalizeCardPath(card.relPath)));
    let staleEntries = 0;
    for (const key of store.tags.keys()) {
      if (!known.has(key)) staleEntries += 1;
    }

    return {
      view: buildBoardView(cards, {
        columns,
        sortBy: config.sortBy,
        showUnassigned: config.showUnassigned,
      }),
      context: {
        boardFile: this.document.uri.fsPath,
        boardFileName: nodePath.basename(this.document.uri.fsPath),
        folderName: nodePath.basename(this.boardDir) || this.boardDir,
        fileCount: scanned.fileCount,
        truncated: scanned.truncated,
        storeError: store.error,
        staleEntries,
        moveTargets: [
          { id: UNASSIGNED_COLUMN_ID, title: UNASSIGNED_COLUMN_TITLE },
          ...columns.map((column) => ({ id: column.id, title: column.title })),
        ],
      },
    };
  }

  private async onMessage(message: FromWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.lastState) this.post({ type: 'state', state: this.lastState });
        else void this.refresh();
        return;
      case 'refresh':
        void this.refresh();
        return;
      case 'openAsText':
        await KanbanEditorProvider.openAsText(this.document.uri);
        return;
      case 'openCard':
        if (message.path) await this.openCard(message.path);
        return;
      case 'moveCard':
        if (message.path && typeof message.columnId === 'string') {
          await this.moveCard(message.path, message.columnId);
        }
        return;
      case 'addList':
        await this.addList(
          typeof message.entry === 'string' ? message.entry : undefined,
          typeof message.index === 'number' ? message.index : undefined,
        );
        return;
      case 'moveList':
        if (typeof message.columnId === 'string' && typeof message.index === 'number') {
          await this.moveList(message.columnId, message.index);
        }
        return;
      case 'removeList':
        if (typeof message.columnId === 'string') {
          await this.removeList(message.columnId);
        }
        return;
      case 'revealCard':
        if (message.path) {
          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(message.path));
        }
        return;
      case 'copyPath':
        if (message.path) {
          const card = this.findCard(message.path);
          await vscode.env.clipboard.writeText(card?.path ?? message.path);
        }
        return;
      default:
        return;
    }
  }

  private findCard(absPath: string) {
    return this.lastState?.view.columns
      .flatMap((column) => column.cards)
      .find((card) => card.id === absPath);
  }

  private async openCard(absPath: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: this.targetColumn(uri),
      });
    } catch (error) {
      logError(`open ${absPath}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: cannot open ${absPath}`);
    }
  }

  /**
   * Picks one stable editor group. `ViewColumn.Beside` would resolve to "the group
   * right of the active one" and open a brand new group on every click, so the
   * column next to the board is used instead and the document is revealed there.
   */
  private targetColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
    if (readConfig().openMode === 'activeTab') return undefined;

    const wanted = normalizePath(uri.fsPath);
    const visible = vscode.window.visibleTextEditors.find(
      (editor) => normalizePath(editor.document.uri.fsPath) === wanted,
    );
    if (visible?.viewColumn) return visible.viewColumn;

    // A tab in the background (not the active one of its group) is not a visible
    // editor, so look through every open tab before opening anything new.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && normalizePath(input.uri.fsPath) === wanted) {
          return group.viewColumn;
        }
      }
    }

    const board = this.panel.viewColumn;
    if (!board || board < 1 || board >= vscode.ViewColumn.Nine) return vscode.ViewColumn.Beside;
    return (board + 1) as vscode.ViewColumn;
  }

  /** Only the board file is ever written; documents are opened read-only. */
  private async moveCard(absPath: string, columnId: string): Promise<void> {
    const config = readConfig();
    const relPath = toPosix(nodePath.relative(this.boardDir, absPath));

    try {
      const before = this.document.getText();
      const parsed = readBoard(before);
      const columns = resolveColumns(parsed.lists, config.columns);

      const column = columns.find((entry) => entry.id === columnId);
      const isUnassigned = columnId === UNASSIGNED_COLUMN_ID;
      if (!column && !isUnassigned) {
        void vscode.window.showErrorMessage(`Markdown Kanban: unknown column "${columnId}".`);
        return;
      }

      const columnTags = new Set(columns.map((entry) => entry.tag.toLowerCase()));
      const current = parsed.tags.get(normalizeCardPath(relPath)) ?? [];
      const next = current.filter((tag) => !columnTags.has(tag.toLowerCase()));
      if (column) next.push(column.tag);

      const sameSet =
        next.length === current.length &&
        current.every((tag) => next.some((candidate) => candidate.toLowerCase() === tag.toLowerCase()));
      if (sameSet) return;

      const update = setCardTags(before, relPath, next);
      if (!(await this.applyBoardUpdate(update))) return;
      await this.refresh();
    } catch (error) {
      logError(`move ${relPath} -> ${columnId}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: ${(error as Error).message}`);
      // The webview moved the card optimistically; put it back where it really is.
      await this.refresh();
    }
  }

  private async addList(rawEntry?: string, index?: number): Promise<void> {
    let entry = rawEntry?.trim();
    if (!entry) {
      entry = (
        await vscode.window.showInputBox({
          title: 'Add list',
          prompt: 'Tag name for the new list (optional "tag:Display Title")',
          placeHolder: 'todo or in-progress:In Progress',
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : 'A list tag is required'),
        })
      )?.trim();
      if (!entry) return;
    }

    const config = readConfig();
    try {
      const update = addBoardList(this.document.getText(), entry, {
        index,
        fallbackLists: config.columns.map(formatColumnEntry),
      });
      if (!(await this.applyBoardUpdate(update))) return;
      await this.refresh();
    } catch (error) {
      logError(`addList ${entry}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: ${(error as Error).message}`);
    }
  }

  private async moveList(columnId: string, index: number): Promise<void> {
    if (columnId === UNASSIGNED_COLUMN_ID) return;
    try {
      const update = moveBoardList(this.document.getText(), columnId, index);
      if (!(await this.applyBoardUpdate(update))) return;
      await this.refresh();
    } catch (error) {
      logError(`moveList ${columnId} -> ${index}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: ${(error as Error).message}`);
    }
  }

  private async removeList(columnId: string): Promise<void> {
    if (columnId === UNASSIGNED_COLUMN_ID) return;
    const config = readConfig();
    try {
      const update = removeBoardList(
        this.document.getText(),
        columnId,
        config.columns.map(formatColumnEntry),
      );
      if (!(await this.applyBoardUpdate(update))) return;
      await this.refresh();
    } catch (error) {
      logError(`removeList ${columnId}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: ${(error as Error).message}`);
    }
  }

  private async applyBoardUpdate(update: StoreUpdate): Promise<boolean> {
    if (!update.changed) return false;
    const wasDirty = this.document.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(
        this.document.positionAt(update.start),
        this.document.positionAt(update.end),
      ),
      update.newText,
    );
    this.applyingEdit = true;
    try {
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showErrorMessage(
          `Markdown Kanban: could not update ${this.document.uri.fsPath}`,
        );
        return false;
      }
    } finally {
      this.applyingEdit = false;
    }
    if (!wasDirty) await this.document.save();
    return true;
  }
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Unsaved editor buffers win over the copy on disk, so moves never lose edits. */
function readTextPreferringOpenDocuments(absPath: string): Promise<string> {
  const wanted = normalizePath(absPath);
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && normalizePath(document.uri.fsPath) === wanted,
  );
  if (open) return Promise.resolve(open.getText());
  return fs.readFile(absPath, 'utf8');
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Markdown Board</title>
  </head>
  <body>
    <div id="app" data-loading="true"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
