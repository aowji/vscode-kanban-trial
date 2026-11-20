import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBoardView,
  parseLists,
  serializeList,
  titleForTag,
  UNASSIGNED_LIST_ID,
  type BoardList,
  type CardInput,
} from '../src/core/board';

function card(overrides: Partial<CardInput> & { title: string }): CardInput {
  return {
    absPath: `C:/notes/${overrides.title}.md`,
    relPath: `notes/${overrides.title}.md`,
    tags: [],
    summary: '',
    updated: 0,
    ...overrides,
  };
}

const lists: BoardList[] = parseLists(['backlog', 'todo', 'in-progress:In Progress', 'done']);

test('parseLists accepts display titles and lower-cases ids', () => {
  assert.deepEqual(
    lists.map((list) => [list.id, list.tag, list.title]),
    [
      ['backlog', 'backlog', 'Backlog'],
      ['todo', 'todo', 'Todo'],
      ['in-progress', 'in-progress', 'In Progress'],
      ['done', 'done', 'Done'],
    ],
  );
});

test('parseLists drops duplicates and returns empty when empty', () => {
  assert.deepEqual(parseLists(['Todo', 'todo']).map((list) => list.id), ['todo']);
  assert.deepEqual(parseLists([]), []);
  assert.deepEqual(parseLists(undefined), []);
});

test('titleForTag keeps acronyms and prettifies separators', () => {
  assert.equal(titleForTag('in-progress'), 'In Progress');
  assert.equal(titleForTag('needs_review'), 'Needs Review');
  assert.equal(titleForTag('TODO'), 'TODO');
});

test('serializeList only spells out a custom title', () => {
  assert.equal(serializeList({ id: 'in-progress', tag: 'in-progress', title: 'In Progress' }), 'in-progress');
  assert.equal(serializeList({ id: 'wip', tag: 'wip', title: 'Work In Progress' }), 'wip:Work In Progress');
});

test('buildBoardView groups cards, keeps extra tags and drops the list tag', () => {
  const view = buildBoardView(
    [
      card({ title: 'old todo', tags: ['todo', 'bug'], updated: 1 }),
      card({ title: 'new todo', tags: ['todo'], updated: 9 }),
      card({ title: 'loose', tags: ['idea'], updated: 5 }),
    ],
    { lists },
  );

  assert.deepEqual(
    view.lists.map((list) => list.id),
    [UNASSIGNED_LIST_ID, 'backlog', 'todo', 'in-progress', 'done'],
  );
  assert.equal(view.totalCards, 3);

  const todo = view.lists.find((list) => list.id === 'todo')!;
  assert.deepEqual(todo.cards.map((entry) => entry.title), ['new todo', 'old todo']);
  assert.deepEqual(todo.cards[1].extraTags, ['bug']);
  assert.equal(todo.cards[1].listTag, 'todo');
  assert.equal(todo.cards[1].listId, 'todo');

  const unassigned = view.lists[0];
  assert.equal(unassigned.tag, null);
  assert.deepEqual(unassigned.cards.map((entry) => entry.title), ['loose']);
  assert.equal(unassigned.cards[0].listTag, null);
});

test('buildBoardView keeps the unassigned list visible even when empty', () => {
  const view = buildBoardView([card({ title: 'a', tags: ['done'] })], { lists });
  assert.deepEqual(
    view.lists.map((list) => list.id),
    [UNASSIGNED_LIST_ID, 'backlog', 'todo', 'in-progress', 'done'],
  );
  assert.equal(view.lists[0].cards.length, 0);
});

test('buildBoardView always exposes cards without a list tag', () => {
  const view = buildBoardView([card({ title: 'loose', tags: [] })], { lists: [] });
  assert.deepEqual(
    view.lists.map((list) => [list.id, list.cards.length]),
    [[UNASSIGNED_LIST_ID, 1]],
  );
});

test('buildBoardView sorts by title when asked', () => {
  const view = buildBoardView(
    [
      card({ title: 'Zebra', tags: ['todo'], updated: 1 }),
      card({ title: 'apple', tags: ['todo'], updated: 2 }),
    ],
    { lists, sortBy: 'title' },
  );
  const todo = view.lists.find((list) => list.id === 'todo')!;
  assert.deepEqual(todo.cards.map((entry) => entry.title), ['apple', 'Zebra']);
});
