import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBoardView,
  formatColumnEntry,
  parseColumns,
  resolveColumns,
  statusTagOf,
  titleForTag,
  UNASSIGNED_COLUMN_ID,
  type BoardCardInput,
  type ParsedColumn,
} from '../src/core/board';

function card(overrides: Partial<BoardCardInput> & { title: string }): BoardCardInput {
  return {
    absPath: `C:/notes/${overrides.title}.md`,
    relPath: `notes/${overrides.title}.md`,
    tags: [],
    summary: '',
    updated: 0,
    ...overrides,
  };
}

const columns: ParsedColumn[] = parseColumns(['backlog', 'todo', 'in-progress:In Progress', 'done']);

test('parseColumns accepts display titles and lower-cases ids', () => {
  assert.deepEqual(
    columns.map((column) => [column.id, column.tag, column.title]),
    [
      ['backlog', 'backlog', 'Backlog'],
      ['todo', 'todo', 'Todo'],
      ['in-progress', 'in-progress', 'In Progress'],
      ['done', 'done', 'Done'],
    ],
  );
});

test('parseColumns drops duplicates and returns empty when empty', () => {
  assert.deepEqual(parseColumns(['Todo', 'todo']).map((c) => c.id), ['todo']);
  assert.deepEqual(parseColumns([]), []);
});

test('titleForTag keeps acronyms and prettifies separators', () => {
  assert.equal(titleForTag('in-progress'), 'In Progress');
  assert.equal(titleForTag('needs_review'), 'Needs Review');
  assert.equal(titleForTag('TODO'), 'TODO');
});

test('resolveColumns prefers the board file over the workspace setting', () => {
  const fallback = parseColumns(['backlog', 'done']);
  const fromBoard = resolveColumns(['design', 'build:Build'], fallback);
  assert.deepEqual(fromBoard.map((column) => [column.id, column.title]), [
    ['design', 'Design'],
    ['build', 'Build'],
  ]);

  assert.deepEqual(
    resolveColumns(undefined, fallback).map((column) => column.id),
    ['backlog', 'done'],
  );
  assert.deepEqual(resolveColumns([], fallback), []);
});

test('formatColumnEntry only spells out a custom title', () => {
  assert.equal(formatColumnEntry({ id: 'in-progress', tag: 'in-progress', title: 'In Progress' }), 'in-progress');
  assert.equal(formatColumnEntry({ id: 'wip', tag: 'wip', title: 'Work In Progress' }), 'wip:Work In Progress');
});

test('statusTagOf returns the first tag owned by a column', () => {
  assert.equal(statusTagOf(['bug', 'Todo'], columns), 'todo');
  assert.equal(statusTagOf(['bug'], columns), null);
});

test('buildBoardView groups cards, keeps extra tags and hides the status tag', () => {
  const view = buildBoardView(
    [
      card({ title: 'old todo', tags: ['todo', 'bug'], updated: 1 }),
      card({ title: 'new todo', tags: ['todo'], updated: 9 }),
      card({ title: 'loose', tags: ['idea'], updated: 5 }),
    ],
    { columns },
  );

  assert.deepEqual(
    view.columns.map((column) => column.id),
    [UNASSIGNED_COLUMN_ID, 'backlog', 'todo', 'in-progress', 'done'],
  );
  assert.equal(view.totalCards, 3);

  const todo = view.columns.find((column) => column.id === 'todo')!;
  assert.deepEqual(todo.cards.map((entry) => entry.title), ['new todo', 'old todo']);
  assert.deepEqual(todo.cards[1].tags, ['bug']);
  assert.equal(todo.cards[1].statusTag, 'todo');

  const unassigned = view.columns[0];
  assert.equal(unassigned.tag, null);
  assert.deepEqual(unassigned.cards.map((entry) => entry.title), ['loose']);
});

test('buildBoardView keeps the unassigned column visible even when empty', () => {
  const view = buildBoardView([card({ title: 'a', tags: ['done'] })], { columns });
  assert.deepEqual(view.columns.map((column) => column.id), [
    UNASSIGNED_COLUMN_ID,
    'backlog',
    'todo',
    'in-progress',
    'done',
  ]);
  assert.equal(view.columns[0].cards.length, 0);
});

test('buildBoardView sorts by title when asked', () => {
  const view = buildBoardView(
    [
      card({ title: 'Zebra', tags: ['todo'], updated: 1 }),
      card({ title: 'apple', tags: ['todo'], updated: 2 }),
    ],
    { columns, sortBy: 'title', showUnassigned: false },
  );
  const todo = view.columns.find((column) => column.id === 'todo')!;
  assert.deepEqual(todo.cards.map((entry) => entry.title), ['apple', 'Zebra']);
});
