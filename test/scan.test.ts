import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { after, before, test } from 'node:test';
import {
  collectMarkdownFiles,
  deriveSummary,
  deriveTitle,
  scanWorkspace,
} from '../src/core/scan';

let root = '';

before(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'md-kanban-'));
  await fs.mkdir(nodePath.join(root, 'notes', 'deep'), { recursive: true });
  await fs.mkdir(nodePath.join(root, 'node_modules', 'pkg'), { recursive: true });

  await fs.writeFile(
    nodePath.join(root, 'todo-card.md'),
    '---\ntitle: Front matter title\ntags:\n  - todo\n---\n\n# Ignored heading\n\nFirst paragraph of the card.\n\nSecond paragraph.\n',
  );
  await fs.writeFile(
    nodePath.join(root, 'notes', 'heading-card.markdown'),
    '# Heading wins\n\nSummary line here.\n',
  );
  await fs.writeFile(nodePath.join(root, 'notes', 'deep', 'bare-file.md'), 'no heading at all\n');
  await fs.writeFile(nodePath.join(root, 'node_modules', 'pkg', 'ignored.md'), '# nope\n');
  await fs.writeFile(nodePath.join(root, 'notes', 'readme.txt'), 'not markdown\n');
  await fs.writeFile(nodePath.join(root, 'kanban.kb.yaml'), 'version: 1\ncards: {}\n');
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('collectMarkdownFiles walks subdirectories and skips ignored folders', async () => {
  const { files, truncated } = await collectMarkdownFiles(root);
  const relative = files.map((file) => nodePath.relative(root, file).split(nodePath.sep).join('/'));
  assert.deepEqual(relative, [
    'notes/deep/bare-file.md',
    'notes/heading-card.markdown',
    'todo-card.md',
  ]);
  assert.equal(truncated, false);
});

test('collectMarkdownFiles honours the file cap', async () => {
  const { files, truncated } = await collectMarkdownFiles(root, { maxFiles: 2 });
  assert.equal(files.length, 2);
  assert.equal(truncated, true);
});

test('scanWorkspace returns titles and summaries without reading tags', async () => {
  const result = await scanWorkspace([{ label: 'root', dir: root }]);
  assert.equal(result.fileCount, 3);

  const byPath = new Map(result.cards.map((card) => [card.relPath, card]));
  const todo = byPath.get('todo-card.md')!;
  assert.equal(todo.title, 'Front matter title');
  assert.equal(todo.summary, 'First paragraph of the card.');
  assert.ok(todo.updated > 0);
  assert.equal('tags' in todo, false, 'the board owns tags, not the document');

  const heading = byPath.get('notes/heading-card.markdown')!;
  assert.equal(heading.title, 'Heading wins');
  assert.equal(heading.summary, 'Summary line here.');

  const bare = byPath.get('notes/deep/bare-file.md')!;
  assert.equal(bare.title, 'bare-file');
  assert.equal(bare.summary, 'no heading at all');
});

test('scanWorkspace prefixes paths when there are several roots', async () => {
  const result = await scanWorkspace([
    { label: 'one', dir: root },
    { label: 'two', dir: nodePath.join(root, 'notes') },
  ]);
  assert.ok(result.cards.some((card) => card.relPath === 'one/todo-card.md'));
  assert.ok(result.cards.some((card) => card.relPath === 'two/deep/bare-file.md'));
});

test('scanWorkspace can read from unsaved buffers', async () => {
  const result = await scanWorkspace([{ label: 'root', dir: root }], {
    readText: async (absPath) =>
      absPath.endsWith('todo-card.md')
        ? '---\ntitle: Edited but not saved\n---\n\n# Edited but not saved\n'
        : fs.readFile(absPath, 'utf8'),
  });
  const todo = result.cards.find((card) => card.relPath === 'todo-card.md')!;
  assert.equal(todo.title, 'Edited but not saved');
});

test('scanWorkspace surfaces broken front matter instead of dropping the card', async () => {
  const broken = nodePath.join(root, 'broken.md');
  await fs.writeFile(broken, '---\ntags: [unclosed\n---\nbody\n');
  try {
    const result = await scanWorkspace([{ label: 'root', dir: root }]);
    const card = result.cards.find((entry) => entry.relPath === 'broken.md')!;
    assert.match(card.error ?? '', /Invalid front matter/);
  } finally {
    await fs.rm(broken, { force: true });
  }
});

test('deriveTitle falls back to the file name', () => {
  assert.equal(deriveTitle({}, 'nothing here', 'my-note.md'), 'my-note');
  assert.equal(deriveTitle({ title: '  Titled  ' }, '', 'x.md'), 'Titled');
});

test('deriveSummary stops at the first blank line and strips markup', () => {
  const summary = deriveSummary('# Title\n\nSome **bold** and [link](http://x) text.\n\n- bullet\n');
  assert.equal(summary, 'Some bold and link text.');
});

test('deriveSummary truncates long paragraphs', () => {
  const summary = deriveSummary('word '.repeat(80), 40);
  assert.ok(summary.length <= 41, summary);
  assert.ok(summary.endsWith('…'));
});
