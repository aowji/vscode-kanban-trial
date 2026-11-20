import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { after, before, test } from 'node:test';
import {
  collectMarkdownFiles,
  deriveSummary,
  deriveTitle,
  scanDirectory,
  stripFrontmatter,
} from '../src/core/scan';

let root = '';

before(async () => {
  root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'md-kanban-'));
  await fs.mkdir(nodePath.join(root, 'notes', 'deep'), { recursive: true });
  await fs.mkdir(nodePath.join(root, 'node_modules', 'pkg'), { recursive: true });

  await fs.writeFile(
    nodePath.join(root, 'todo-card.md'),
    '---\ntitle: Front matter title\ntags:\n  - todo\n---\n\n# Heading after front matter\n\nFirst paragraph of the card.\n\nSecond paragraph.\n',
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

test('collectMarkdownFiles walks subdirectories and skips excluded folders', async () => {
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

test('collectMarkdownFiles respects a custom exclusion list', async () => {
  // A custom list replaces the defaults, so node_modules is scanned again.
  const { files } = await collectMarkdownFiles(root, { excludeDirectories: ['notes'] });
  const relative = files.map((file) => nodePath.relative(root, file).split(nodePath.sep).join('/'));
  assert.deepEqual(relative, ['node_modules/pkg/ignored.md', 'todo-card.md']);
});

test('scanDirectory returns titles, summaries and POSIX paths', async () => {
  const result = await scanDirectory(root);
  assert.equal(result.fileCount, 3);
  assert.equal(result.truncated, false);

  const byPath = new Map(result.cards.map((card) => [card.relPath, card]));
  const todo = byPath.get('todo-card.md')!;
  assert.equal(todo.title, 'Heading after front matter');
  assert.equal(todo.summary, 'First paragraph of the card.');
  assert.ok(todo.updated > 0);

  const heading = byPath.get('notes/heading-card.markdown')!;
  assert.equal(heading.title, 'Heading wins');
  assert.equal(heading.summary, 'Summary line here.');

  const bare = byPath.get('notes/deep/bare-file.md')!;
  assert.equal(bare.title, 'bare-file');
  assert.equal(bare.summary, 'no heading at all');
});

test('scanDirectory can read from unsaved buffers', async () => {
  const result = await scanDirectory(root, {
    readText: async (absPath) =>
      absPath.endsWith('todo-card.md')
        ? '---\ntitle: stub\n---\n\n# Unsaved heading\n\nUnsaved body.\n'
        : fs.readFile(absPath, 'utf8'),
  });
  const todo = result.cards.find((card) => card.relPath === 'todo-card.md')!;
  assert.equal(todo.title, 'Unsaved heading');
});

test('scanDirectory surfaces an unclosed front matter block instead of dropping the card', async () => {
  const broken = nodePath.join(root, 'broken.md');
  await fs.writeFile(broken, '---\ntitle: never closed\n\n# body heading\n');
  try {
    const result = await scanDirectory(root);
    const card = result.cards.find((entry) => entry.relPath === 'broken.md')!;
    assert.match(card.error ?? '', /no closing line/);
  } finally {
    await fs.rm(broken, { force: true });
  }
});

test('stripFrontmatter drops the metadata block', () => {
  assert.equal(
    stripFrontmatter('---\ntitle: T\ntags: [a]\n---\n\n# H\n\nBody.\n').body,
    '\n# H\n\nBody.\n',
  );
  assert.equal(stripFrontmatter('---\ntitle: T\n...\nBody.\n').body, 'Body.\n');
  assert.equal(stripFrontmatter('---\n---\nBody.\n').body, 'Body.\n');
});

test('stripFrontmatter leaves documents without front matter untouched', () => {
  assert.deepEqual(stripFrontmatter('# Just a heading\n\ntext\n'), {
    body: '# Just a heading\n\ntext\n',
  });
});

test('stripFrontmatter handles BOM and CRLF documents', () => {
  assert.equal(stripFrontmatter('\uFEFF---\r\ntitle: T\r\n---\r\nbody\r\n').body, 'body\r\n');
});

test('stripFrontmatter reports an unclosed block instead of eating the document', () => {
  const text = '---\ntitle: T\n\n# heading\n';
  assert.deepEqual(stripFrontmatter(text), {
    body: text,
    error: 'Front matter starts with "---" but has no closing line.',
  });
});

test('deriveTitle prefers a heading and falls back to the file name', () => {
  assert.equal(deriveTitle('nothing here', 'my-note.md'), 'my-note');
  assert.equal(deriveTitle('#   Spaced heading  \n', 'x.md'), 'Spaced heading');
  assert.equal(deriveTitle('#\n', 'from-name.markdown'), 'from-name');
});

test('deriveTitle ignores headings inside fenced code blocks', () => {
  assert.equal(
    deriveTitle('```\n# not a title\n```\n\n# Real title\n', 'fallback.md'),
    'Real title',
  );
  assert.equal(deriveTitle('~~~\n# not a title\n~~~\n\nbody\n', 'fallback.md'), 'fallback');
});

test('deriveSummary stops at the first blank line and strips markup', () => {
  const summary = deriveSummary('# Title\n\nSome **bold** and [link](http://x) text.\n\n- bullet\n');
  assert.equal(summary, 'Some bold and link text.');
});

test('deriveSummary keeps underscores inside words and code spans', () => {
  assert.equal(
    deriveSummary('Call snake_case_name and _emphasised_ text.'),
    'Call snake_case_name and emphasised text.',
  );
  assert.equal(deriveSummary('Use my_file_name.md here.'), 'Use my_file_name.md here.');
  assert.equal(deriveSummary('Run `__init__` first.'), 'Run __init__ first.');
});

test('deriveSummary truncates long paragraphs', () => {
  const summary = deriveSummary('word '.repeat(80), 40);
  assert.ok(summary.length <= 41, summary);
  assert.ok(summary.endsWith('…'));
});
