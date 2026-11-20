import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFrontmatter } from '../src/core/frontmatter';

test('readFrontmatter separates data and body', () => {
  const info = readFrontmatter('---\ntags:\n  - todo\ntitle: Hello\n---\n\n# Hello\n\nBody.\n');
  assert.equal(info.error, undefined);
  assert.deepEqual(info.data, { tags: ['todo'], title: 'Hello' });
  assert.equal(info.body, '\n# Hello\n\nBody.\n');
});

test('readFrontmatter reports a missing block', () => {
  const info = readFrontmatter('# Just a heading\n\ntext\n');
  assert.equal(info.block, null);
  assert.equal(info.body, '# Just a heading\n\ntext\n');
});

test('readFrontmatter flags an unterminated fence', () => {
  const info = readFrontmatter('---\ntags: [todo]\n\n# no closing fence\n');
  assert.equal(info.block, null);
  assert.match(info.error ?? '', /Unterminated/);
});

test('readFrontmatter keeps a BOM out of the front matter', () => {
  const info = readFrontmatter('\uFEFF---\ntags: [todo]\n---\nbody\n');
  assert.deepEqual(info.data, { tags: ['todo'] });
  assert.equal(info.body, 'body\n');
});

test('readFrontmatter handles CRLF documents', () => {
  const info = readFrontmatter('---\r\ntags:\r\n  - done\r\n---\r\n\r\n# Title\r\n');
  assert.deepEqual(info.data, { tags: ['done'] });
  assert.equal(info.body, '\r\n# Title\r\n');
});

test('readFrontmatter reports invalid YAML', () => {
  const info = readFrontmatter('---\ntags: [unclosed\n---\nbody\n');
  assert.match(info.error ?? '', /Invalid front matter/);
});
