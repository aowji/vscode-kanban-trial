import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
  buildBoardView,
  UNASSIGNED_LIST_ID,
  type BoardList,
  type BoardView,
  type CardInput,
  type CardView,
} from './core/board';
import { scanDirectory, toPosixPath, type ScanResult } from './core/scan';
import {
  addBoardList,
  moveBoardList,
  readBoard,
  removeBoardList,
  renameListTag,
  setCardTags,
  toCardKey,
  type StoreUpdate,
} from './core/store';
import { CONFIG_SECTION, readConfig } from './config';
import { log, logError } from './log';

export const VIEW_TYPE = 'markdownKanban.board';
const REFRESH_DEBOUNCE_MS = 250;
const PLAIN_EDITOR = 'default';

interface BoardState {
  view: BoardView;
  meta: {
    /** Absolute path of the board file. */
    boardFile: string;
    boardFileName: string;
    folderName: string;
    fileCount: number;
    truncated: boolean;
    storeError?: string;
    /** Board entries whose document no longer exists. */
    staleEntries: number;
  };
}

interface FromWebviewMessage {
  type?: string;
  path?: string;
  listId?: string | null;
  entry?: string;
  /** Insert position for `addList`, and destination for `moveList`. */
  index?: number;
}

/**
 * Registers `*.kb.yaml` as a custom editor, so the board is the default way to
 * open a board file. Because it is a *text* custom editor, the same document can
 * still be edited as YAML via "Reopen Editor With…".
 */
export class KanbanEditorProvider implements vscode.CustomTextEditorProvider {
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
    void new KanbanEditor(panel, this.extensionUri, document);
    log(`board editor resolved for ${document.uri.fsPath}`);
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
  /** Last directory scan; reused while only the board file changes. */
  private scan: ScanResult | undefined;
  private scanStale = true;
  private disposed = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly document: vscode.TextDocument,
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
        const uri = event.document.uri;
        if (uri.toString() === this.document.uri.toString()) {
          if (this.applyingEdit) return;
          this.scheduleRefresh();
          return;
        }
        // Unsaved buffers win over the copy on disk, so a document edit makes
        // the cached scan stale even before the file is saved.
        if (uri.scheme === 'file' && isMarkdownUnder(this.boardDir, uri.fsPath)) {
          this.scanStale = true;
        }
      },
      undefined,
      this.disposables,
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.boardDir), '**/*.{md,markdown}'),
    );
    const markStale = (): void => {
      this.scanStale = true;
      this.scheduleRefresh();
    };
    watcher.onDidChange(markStale, undefined, this.disposables);
    watcher.onDidCreate(markStale, undefined, this.disposables);
    watcher.onDidDelete(markStale, undefined, this.disposables);
    this.disposables.push(watcher);

    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION)) return;
        this.scanStale = true;
        this.scheduleRefresh(0);
      },
      undefined,
      this.disposables,
    );
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => {
        this.scanStale = true;
        this.scheduleRefresh(0);
      },
      undefined,
      this.disposables,
    );
  }

  private dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    while (this.disposables.length > 0) this.disposables.pop()?.dispose();
    log(`board editor disposed (${this.document.uri.fsPath})`);
  }

  private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.disposed) return;
    // Scanning while the tab is hidden only burns IO; the view-state handler
    // refreshes when the panel becomes visible again.
    if (!this.panel.visible) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
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
    const board = readBoard(this.document.getText());
    // A board file that defines `lists` (even as `[]`) owns its lists; the
    // setting is only the fallback when the key is missing entirely.
    const lists: BoardList[] = board.lists ?? config.lists;
    if (this.scanStale || !this.scan) {
      this.scanStale = false;
      try {
        this.scan = await scanDirectory(this.boardDir, {
          excludeDirectories: config.excludeDirectories,
          maxFiles: config.maxFiles,
          readText: readTextPreferringOpenDocuments,
        });
      } catch (error) {
        this.scanStale = true;
        throw error;
      }
    }
    const scanned = this.scan;

    const cards: CardInput[] = [];
    const known = new Set<string>();
    for (const card of scanned.cards) {
      const key = toCardKey(card.relPath);
      known.add(key);
      cards.push({ ...card, tags: board.cardTags.get(key) ?? [] });
    }
    const staleEntries = [...board.cardTags.keys()].filter((key) => !known.has(key)).length;

    return {
      view: buildBoardView(cards, { lists, sortBy: config.sortBy }),
      meta: {
        boardFile: this.document.uri.fsPath,
        boardFileName: nodePath.basename(this.document.uri.fsPath),
        folderName: nodePath.basename(this.boardDir) || this.boardDir,
        fileCount: scanned.fileCount,
        truncated: scanned.truncated,
        storeError: board.error,
        staleEntries,
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
        // An explicit reload is the escape hatch for a missed file event.
        this.scanStale = true;
        void this.refresh();
        return;
      case 'openAsText':
        await KanbanEditorProvider.openAsText(this.document.uri);
        return;
      case 'openCard':
        if (message.path) await this.openCard(message.path);
        return;
      case 'moveCard':
        if (message.path && typeof message.listId === 'string') {
          await this.moveCard(message.path, message.listId);
        }
        return;
      case 'addList':
        await this.addList(
          typeof message.entry === 'string' ? message.entry : undefined,
          typeof message.index === 'number' ? message.index : undefined,
        );
        return;
      case 'moveList':
        if (typeof message.listId === 'string' && typeof message.index === 'number') {
          await this.moveList(message.listId, message.index);
        }
        return;
      case 'removeList':
        if (typeof message.listId === 'string') await this.removeList(message.listId);
        return;
      case 'renameList':
        if (typeof message.listId === 'string') await this.renameList(message.listId);
        return;
      case 'revealCard':
        if (message.path) {
          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(message.path));
        }
        return;
      case 'copyPath':
        if (message.path) {
          const card = this.findCardView(message.path);
          await vscode.env.clipboard.writeText(card?.relPath ?? message.path);
        }
        return;
      default:
        return;
    }
  }

  private findCardView(absPath: string): CardView | undefined {
    return this.lastState?.view.lists
      .flatMap((list) => list.cards)
      .find((card) => card.absPath === absPath);
  }

  private async openCard(absPath: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: this.targetViewColumn(uri),
      });
    } catch (error) {
      logError(`open ${absPath}`, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: cannot open ${absPath}`);
    }
  }

  /**
   * Picks one stable editor group. `ViewColumn.Beside` would resolve to "the group
   * right of the active one" and open a brand new group on every click, so the
   * group next to the board is used instead and the document is revealed there.
   */
  private targetViewColumn(uri: vscode.Uri): vscode.ViewColumn | undefined {
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

    const boardColumn = this.panel.viewColumn;
    if (!boardColumn || boardColumn < 1 || boardColumn >= vscode.ViewColumn.Nine) {
      return vscode.ViewColumn.Beside;
    }
    return (boardColumn + 1) as vscode.ViewColumn;
  }

  /** Only the board file is ever written; documents are opened read-only. */
  private async moveCard(absPath: string, listId: string): Promise<void> {
    const config = readConfig();
    const relPath = toPosixPath(nodePath.relative(this.boardDir, absPath));
    const before = this.document.getText();
    const board = readBoard(before);
    const lists = board.lists ?? config.lists;

    const list = lists.find((entry) => entry.id === listId);
    if (!list && listId !== UNASSIGNED_LIST_ID) {
      void vscode.window.showErrorMessage(`Markdown Kanban: unknown list "${listId}".`);
      return;
    }

    const current = board.cardTags.get(toCardKey(relPath)) ?? [];
    const listTags = new Set(lists.map((entry) => entry.tag.toLowerCase()));
    const next = current.filter((tag) => !listTags.has(tag.toLowerCase()));
    if (list) next.push(list.tag);

    // Dropping a card back into its own column: skip, otherwise a hand-written
    // `tags: [a]` would be reformatted into block style for no reason.
    const unchanged =
      next.length === current.length &&
      current.every((tag) => next.some((other) => other.toLowerCase() === tag.toLowerCase()));
    if (unchanged) return;

    await this.runMutation(
      `move ${relPath} -> ${listId}`,
      () => setCardTags(before, relPath, next),
      true,
    );
  }

  private async addList(rawEntry?: string, index?: number): Promise<void> {
    let entry = rawEntry?.trim();
    if (!entry) {
      entry = (
        await vscode.window.showInputBox({
          title: 'Add list',
          prompt: 'Name of the new list; it becomes the tag its cards carry',
          placeHolder: 'todo',
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim() ? undefined : 'A list name is required'),
        })
      )?.trim();
      if (!entry) return;
    }

    await this.runMutation(`addList ${entry}`, () =>
      addBoardList(this.document.getText(), entry, {
        index,
        fallbackLists: configTags(),
      }),
    );
  }

  private async moveList(listId: string, index: number): Promise<void> {
    if (listId === UNASSIGNED_LIST_ID) return;
    await this.runMutation(`moveList ${listId} -> ${index}`, () =>
      moveBoardList(this.document.getText(), listId, index),
    );
  }

  private async removeList(listId: string): Promise<void> {
    if (listId === UNASSIGNED_LIST_ID) return;
    await this.runMutation(`removeList ${listId}`, () =>
      removeBoardList(this.document.getText(), listId, configTags()),
    );
  }

  private async renameList(listId: string): Promise<void> {
    if (listId === UNASSIGNED_LIST_ID) return;
    const config = readConfig();
    const board = readBoard(this.document.getText());
    const list = (board.lists ?? config.lists).find((entry) => entry.id === listId);
    if (!list) return;

    const value = await vscode.window.showInputBox({
      title: 'Rename list',
      prompt: `New name for "${list.tag}"; the tag on its cards is renamed too`,
      value: list.tag,
      ignoreFocusOut: true,
      validateInput: (input) => (input.trim() ? undefined : 'A list name is required'),
    });
    const tag = value?.trim();
    if (!tag || tag === list.tag) return;

    const fallbackLists = config.lists.map((entry) => entry.tag);
    await this.runMutation(`renameList ${listId} -> ${tag}`, () =>
      renameListTag(this.document.getText(), listId, tag, fallbackLists),
    );
  }

  /**
   * Writes one board update and refreshes. Failures are logged and reported;
   * `refreshOnError` is for mutations the webview applied optimistically, which
   * have to be redrawn from the file when the write fails.
   */
  private async runMutation(
    label: string,
    build: () => StoreUpdate,
    refreshOnError = false,
  ): Promise<void> {
    try {
      if (!(await this.applyBoardUpdate(build()))) return;
      await this.refresh();
    } catch (error) {
      logError(label, error);
      void vscode.window.showErrorMessage(`Markdown Kanban: ${(error as Error).message}`);
      if (refreshOnError) await this.refresh();
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

/** True for a Markdown document that the board's scan would include. */
function isMarkdownUnder(directory: string, absPath: string): boolean {
  if (!/\.(md|markdown)$/i.test(absPath)) return false;
  const relative = nodePath.relative(directory, absPath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

/** Configured lists as plain tags, used to seed a board file without `lists:`. */
function configTags(): string[] {
  return readConfig().lists.map((list) => list.tag);
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
