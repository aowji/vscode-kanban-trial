import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { after, before, test } from 'node:test';
import { serializeList, type BoardList } from '../src/core/board';
import { readBoard } from '../src/core/store';

/** Lists as they would be written back to the file, e.g. `todo` or `wip:WIP`. */
const listEntries = (text: string): string[] | undefined =>
  (readBoard(text).lists as BoardList[] | undefined)?.map(serializeList);

/**
 * Drives the real extension code against a minimal `vscode` shim:
 * activate -> register the custom editor -> open a *.kb.yaml -> webview messages.
 */

class Uri {
  constructor(readonly fsPath: string) {}
  get path(): string {
    return this.fsPath.replace(/\\/g, '/');
  }
  get scheme(): string {
    return 'file';
  }
  toString(): string {
    return `file://${this.path}`;
  }
  static file(value: string): Uri {
    return new Uri(value);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(nodePath.join(base.fsPath, ...parts));
  }
}

interface FakeDocument {
  uri: Uri;
  readonly isDirty: boolean;
  getText(): string;
  positionAt(offset: number): { line: number; character: number; offset: number };
  save(): Promise<void>;
  replaceText(next: string): void;
}

function createDocument(uri: Uri, initial: string): FakeDocument {
  let value = initial;
  let saved = initial;
  return {
    uri,
    get isDirty() {
      return value !== saved;
    },
    getText: () => value,
    positionAt(offset: number) {
      const before = value.slice(0, offset);
      return {
        line: before.split('\n').length - 1,
        character: offset - (before.lastIndexOf('\n') + 1),
        offset,
      };
    },
    async save() {
      saved = value;
      // Write-then-rename: a plain writeFile would let the test's polling reads
      // observe a half-written file.
      const temp = `${uri.fsPath}.tmp`;
      await fs.writeFile(temp, value, 'utf8');
      await fs.rename(temp, uri.fsPath);
    },
    replaceText(next: string) {
      value = next;
    },
  };
}

function addDisposable(list: unknown, disposable: { dispose(): void }): { dispose(): void } {
  if (Array.isArray(list)) list.push(disposable);
  return disposable;
}

function createFakeVscode(root: string, config: Record<string, unknown>) {
  const harness = {
    messages: [] as any[],
    commands: [] as { command: string; args: any[] }[],
    clipboard: [] as string[],
    errors: [] as string[],
    inputs: [] as string[],
    opened: [] as { path: string; viewColumn: unknown; preview: unknown }[],
    visibleEditors: [] as { viewColumn: number; document: { uri: Uri } }[],
    tabGroups: [] as { viewColumn: number; tabs: { input: unknown }[] }[],
    webviewHtml: '',
    panelDisposed: false,
    panelsCreated: 0,
    activeEditor: undefined as any,
    output: [] as string[],
    docChangeHandlers: [] as ((event: { document: FakeDocument }) => void)[],
    provider: undefined as
      | { resolveCustomTextEditor(document: any, panel: any, token: any): void }
      | undefined,
    providerOptions: undefined as any,
  };
  const documents = new Map<string, FakeDocument>();
  const registered = new Map<string, (...args: any[]) => any>();
  let onMessage: ((message: any) => void) | undefined;
  let onDispose: (() => void) | undefined;

  async function openDocument(uri: Uri): Promise<FakeDocument> {
    const existing = documents.get(uri.fsPath);
    if (existing) return existing;
    const doc = createDocument(uri, await fs.readFile(uri.fsPath, 'utf8'));
    documents.set(uri.fsPath, doc);
    return doc;
  }

  const webview = {
    cspSource: 'vscode-webview://test',
    get html() {
      return harness.webviewHtml;
    },
    set html(value: string) {
      harness.webviewHtml = value;
    },
    options: {} as any,
    asWebviewUri: (uri: Uri) => `https://webview.test${uri.path}`,
    postMessage: async (message: unknown) => {
      harness.messages.push(message);
      return true;
    },
    onDidReceiveMessage: (handler: (message: any) => void) => {
      onMessage = handler;
      return { dispose() {} };
    },
  };

  const createPanel = () => {
    harness.panelsCreated += 1;
    return {
      webview,
      viewColumn: 1 as number | undefined,
      iconPath: undefined as unknown,
      reveal: () => undefined,
      dispose: () => {
        harness.panelDisposed = true;
      },
      onDidChangeViewState: () => ({ dispose() {} }),
      onDidDispose: (handler: () => void) => {
        onDispose = () => {
          harness.panelDisposed = true;
          handler();
        };
        return { dispose() {} };
      },
    };
  };

  const fireDocChange = (document: FakeDocument) => {
    for (const handler of harness.docChangeHandlers) handler({ document });
  };

  const vscode = {
    Uri,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Nine: 9 },
    RelativePattern: class {
      constructor(
        readonly base: Uri | string,
        readonly pattern: string,
      ) {}
    },
    TabInputText: class {
      constructor(readonly uri: Uri) {}
    },
    Position: class {},
    Range: class {
      constructor(
        readonly start: { offset: number },
        readonly end: { offset: number },
      ) {}
    },
    WorkspaceEdit: class {
      readonly edits: { uri: Uri; start: number; end: number; newText: string }[] = [];
      replace(uri: Uri, range: any, newText: string) {
        this.edits.push({ uri, start: range.start.offset, end: range.end.offset, newText });
      }
    },
    env: {
      clipboard: {
        writeText: async (value: string) => {
          harness.clipboard.push(value);
        },
      },
    },
    commands: {
      executeCommand: async (command: string, ...args: any[]) => {
        harness.commands.push({ command, args });
        if (command === 'vscode.openWith' && args[1] === 'markdownKanban.board') {
          const document = await openDocument(args[0] as Uri);
          harness.provider!.resolveCustomTextEditor(document, createPanel(), {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
          });
        }
        return undefined;
      },
      registerCommand: (id: string, handler: (...args: any[]) => any) => {
        registered.set(id, handler);
        return { dispose() {} };
      },
    },
    window: {
      showErrorMessage: (message: string) => {
        harness.errors.push(message);
        return Promise.resolve(undefined);
      },
      showInformationMessage: async () => undefined,
      get visibleTextEditors() {
        return harness.visibleEditors;
      },
      get tabGroups() {
        return { all: harness.tabGroups };
      },
      get activeTextEditor() {
        return harness.activeEditor;
      },
      showTextDocument: async (document: any, options?: any) => {
        harness.opened.push({
          path: document.uri.fsPath,
          viewColumn: options?.viewColumn,
          preview: options?.preview,
        });
      },
      showInputBox: async () => harness.inputs.shift(),
      showQuickPick: async (items: any[]) => items[0],
      createWebviewPanel: () => createPanel(),
      createOutputChannel: () => ({
        appendLine: (line: string) => harness.output.push(line),
        dispose: () => undefined,
      }),
      registerCustomEditorProvider: (viewType: string, provider: any, options: any) => {
        assert.equal(viewType, 'markdownKanban.board');
        harness.provider = provider;
        harness.providerOptions = options;
        return { dispose() {} };
      },
    },
    workspace: {
      name: 'fixture',
      workspaceFolders: [{ name: 'fixture', uri: Uri.file(root) }],
      get textDocuments() {
        return [...documents.values()];
      },
      getConfiguration: () => ({ get: (key: string) => config[key] }),
      createFileSystemWatcher: () => ({
        onDidChange: () => ({ dispose() {} }),
        onDidCreate: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose: () => undefined,
      }),
      findFiles: async () => [],
      onDidChangeConfiguration: (_handler: unknown, _this: unknown, list: unknown) =>
        addDisposable(list, { dispose() {} }),
      onDidChangeWorkspaceFolders: (_handler: unknown, _this: unknown, list: unknown) =>
        addDisposable(list, { dispose() {} }),
      onDidChangeTextDocument: (
        handler: (event: { document: FakeDocument }) => void,
        _this: unknown,
        list: unknown,
      ) => {
        harness.docChangeHandlers.push(handler);
        return addDisposable(list, { dispose() {} });
      },
      openTextDocument: (uri: Uri) => openDocument(uri),
      applyEdit: async (edit: {
        edits: { uri: Uri; start: number; end: number; newText: string }[];
      }) => {
        for (const change of edit.edits) {
          const doc = await openDocument(change.uri);
          const current = doc.getText();
          doc.replaceText(
            current.slice(0, change.start) + change.newText + current.slice(change.end),
          );
          fireDocChange(doc);
        }
        return true;
      },
      fs: {
        stat: async (uri: Uri) => {
          const info = await fs.stat(uri.fsPath);
          return { size: info.size };
        },
        writeFile: async (uri: Uri, content: Uint8Array) => {
          await fs.writeFile(uri.fsPath, content);
        },
      },
    },
  };

  return {
    vscode,
    harness,
    documents,
    registered,
    createPanel,
    fireDocChange,
    send: (message: any) => onMessage?.(message),
    disposePanel: () => onDispose?.(),
  };
}

async function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForText(
  file: string,
  predicate: (text: string) => boolean,
  label: string,
): Promise<string> {
  return waitFor(async () => {
    const text = await fs.readFile(file, 'utf8');
    return predicate(text) ? text : undefined;
  }, label);
}

const FIXTURE_MARKDOWN = '# Fix login redirect\n\nBounces between pages.\n';
const FIXTURE_BOARD = [
  'version: 1',
  'cards:',
  '  fix-login.md:',
  '    tags:',
  '      - todo',
  '      - bug',
  '',
].join('\n');

let root = '';
let boardPath = '';

before(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'md-kanban-board-'));
  await fs.mkdir(nodePath.join(root, 'docs'), { recursive: true });
  boardPath = nodePath.join(root, 'kanban.kb.yaml');
  await fs.writeFile(nodePath.join(root, 'fix-login.md'), FIXTURE_MARKDOWN);
  await fs.writeFile(nodePath.join(root, 'docs', 'loose.md'), '# Loose note\n\nNo status yet.\n');
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('*.kb.yaml opens as a custom editor that reads and writes the board file', async () => {
  const fake = createFakeVscode(root, {
    defaultLists: ['backlog', 'todo', 'in-progress:In Progress', 'review', 'done'],
    excludeDirectories: ['node_modules'],
    sortBy: 'updated',
    openMode: 'beside',
    maxFiles: 500,
  });

  const originalLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'vscode') return fake.vscode;
    return originalLoad.call(this, request, ...rest);
  };

  try {
    const { activate } = await import('../src/extension');
    activate({ subscriptions: [], extensionUri: Uri.file(root) } as any);

    assert.deepEqual([...fake.registered.keys()].sort(), [
      'markdownKanban.createBoardFile',
      'markdownKanban.openAsText',
      'markdownKanban.openBoard',
    ]);
    assert.ok(fake.harness.provider, 'the custom editor provider must be registered');
    assert.deepEqual(fake.harness.providerOptions, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });

    // Creating a board file writes the template and opens it in the board editor.
    await fake.registered.get('markdownKanban.createBoardFile')!();
    const template = await fs.readFile(boardPath, 'utf8');
    assert.match(template, /^# Markdown Kanban board\./);
    // Titles equal to the prettified tag are written in short form.
    assert.deepEqual(listEntries(template), [
      'backlog',
      'todo',
      'in-progress',
      'review',
      'done',
    ]);
    assert.equal(fake.harness.panelsCreated, 1);

    // Seed data through the document the extension reads.
    const boardDocument = fake.documents.get(boardPath)!;
    boardDocument.replaceText(FIXTURE_BOARD);
    await boardDocument.save();

    fake.send({ type: 'ready' });
    const firstState = await waitFor(
      () => fake.harness.messages.find((message) => message.type === 'state')?.state,
      'initial board state',
    );

    assert.equal(firstState.meta.boardFileName, 'kanban.kb.yaml');
    assert.equal(firstState.view.totalCards, 2);
    assert.deepEqual(
      firstState.view.lists.map((list: any) => list.id),
      ['__unassigned', 'backlog', 'todo', 'in-progress', 'review', 'done'],
    );

    // Moving a card rewrites only the board file.
    fake.send({ type: 'moveCard', path: nodePath.join(root, 'fix-login.md'), listId: 'review' });
    const moved = await waitForText(boardPath, (text) => text.includes('- review'), 'the move');
    assert.equal(
      moved,
      ['version: 1', 'cards:', '  fix-login.md:', '    tags:', '      - bug', '      - review', ''].join('\n'),
    );
    assert.equal(await fs.readFile(nodePath.join(root, 'fix-login.md'), 'utf8'), FIXTURE_MARKDOWN);

    // Unknown lists are rejected.
    fake.harness.errors.length = 0;
    fake.send({ type: 'moveCard', path: nodePath.join(root, 'fix-login.md'), listId: 'nope' });
    const error = await waitFor(() => fake.harness.errors[0], 'an error for the unknown list');
    assert.match(error, /unknown list/);

    // Lists: insert at an index, reorder, then remove. The board file has no
    // `lists:` key, so the configured lists are used as the seed (fallback).
    fake.send({ type: 'addList', entry: 'qa:QA', index: 0 });
    const withQa = await waitForText(boardPath, (text) => text.includes('qa:QA'), 'the inserted list');
    assert.deepEqual(listEntries(withQa), [
      'qa:QA',
      'backlog',
      'todo',
      'in-progress',
      'review',
      'done',
    ]);

    fake.send({ type: 'moveList', listId: 'done', index: 0 });
    const reordered = await waitForText(
      boardPath,
      (text) => listEntries(text)?.[0] === 'done',
      'the reordered lists',
    );
    assert.deepEqual(listEntries(reordered), [
      'done',
      'qa:QA',
      'backlog',
      'todo',
      'in-progress',
      'review',
    ]);

    fake.send({ type: 'removeList', listId: 'qa' });
    const withoutQa = await waitForText(boardPath, (text) => !text.includes('qa:QA'), 'list removal');
    assert.deepEqual(listEntries(withoutQa), [
      'done',
      'backlog',
      'todo',
      'in-progress',
      'review',
    ]);

    // The list menu path: no entry -> the extension prompts for the tag.
    fake.harness.inputs.push('refine');
    fake.send({ type: 'addList', index: 1 });
    const prompted = await waitForText(boardPath, (text) => text.includes('refine'), 'the prompted list');
    assert.equal(listEntries(prompted)?.[1], 'refine');

    // "Add list before" on the first list inserts at index 0.
    fake.harness.inputs.push('intake');
    fake.send({ type: 'addList', index: 0 });
    const prepended = await waitForText(boardPath, (text) => text.includes('intake'), 'the prepended list');
    assert.equal(listEntries(prepended)?.[0], 'intake');

    // External edits to the board file refresh the webview.
    const statesBefore = fake.harness.messages.filter((m) => m.type === 'state').length;
    boardDocument.replaceText('version: 1\nlists:\n  - design\ncards: {}\n');
    fake.fireDocChange(boardDocument);
    const afterExternal = await waitFor(() => {
      const states = fake.harness.messages.filter((m) => m.type === 'state');
      const last = states[states.length - 1]?.state;
      return states.length > statesBefore && last?.meta.storeError === undefined ? last : undefined;
    }, 'refresh after an external edit');
    assert.deepEqual(afterExternal.view.lists.map((list: any) => list.id), ['__unassigned', 'design']);

    // Opening a card three times reuses one editor group.
    const clicked = nodePath.join(root, 'fix-login.md');
    fake.harness.opened.length = 0;
    fake.send({ type: 'openCard', path: clicked });
    fake.send({ type: 'openCard', path: clicked });
    fake.send({ type: 'openCard', path: clicked });
    await waitFor(() => (fake.harness.opened.length >= 3 ? true : undefined), 'three opens');
    assert.deepEqual(fake.harness.opened.map((entry) => entry.viewColumn), [2, 2, 2]);

    fake.send({ type: 'revealCard', path: clicked });
    fake.send({ type: 'copyPath', path: clicked });
    await waitFor(
      () => fake.harness.commands.find((entry) => entry.command === 'revealInExplorer'),
      'revealInExplorer',
    );
    const copied = await waitFor(
      () => (fake.harness.clipboard.length ? fake.harness.clipboard[0] : undefined),
      'clipboard',
    );
    assert.equal(copied, 'fix-login.md');

    // "Edit as YAML" switches the same document to the plain text editor.
    fake.harness.commands.length = 0;
    fake.send({ type: 'openAsText' });
    const plain = await waitFor(
      () => fake.harness.commands.find((entry) => entry.command === 'vscode.openWith' && entry.args[1] === 'default'),
      'openWith default',
    );
    assert.equal(plain.args[0].fsPath, boardPath);

    // The Open Board command resolves the active *.kb.yaml and opens the custom editor.
    fake.harness.panelsCreated = 0;
    fake.harness.activeEditor = { document: { uri: Uri.file(boardPath) } };
    await fake.registered.get('markdownKanban.openBoard')!();
    assert.equal(fake.harness.panelsCreated, 1);

    // Disposing the editor stops further posts.
    fake.disposePanel();
    await waitFor(() => (fake.harness.panelDisposed ? true : undefined), 'panel disposal');
  } finally {
    (Module as any)._load = originalLoad;
  }
});

test('the manifest makes *.kb.yaml a default board preview', async () => {
  const manifest = JSON.parse(
    await fs.readFile(nodePath.join(process.cwd(), 'package.json'), 'utf8'),
  );
  const editor = manifest.contributes.customEditors.find(
    (entry: any) => entry.viewType === 'markdownKanban.board',
  );
  assert.ok(editor, 'customEditors must declare the board view type');
  assert.equal(editor.priority, 'default');
  assert.deepEqual(
    editor.selector.map((entry: any) => entry.filenamePattern),
    ['*.kb.yaml', '*.kb.yml'],
  );
  assert.ok(manifest.contributes.configuration.properties['markdownKanban.defaultLists']);
  assert.equal(
    manifest.contributes.configuration.properties['markdownKanban.showUnassigned'],
    undefined,
    'the hiding-the-unassigned-list setting is gone',
  );
  assert.equal(
    manifest.contributes.commands.some((command: any) => command.command === 'markdownKanban.refreshBoard'),
    false,
    'the redundant refresh command is gone',
  );
});
