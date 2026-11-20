import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBoardView,
  parseLists,
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

const lists: BoardList[] = parseLists(['backlog', 'todo', 'in-progress', 'done']);

test('parseLists keeps tags verbatim and lower-cases only the id', () => {
  assert.deepEqual(
    parseLists(['Backlog', 'TODO', 'in-progress']).map((list) => [list.id, list.tag]),
    [
      ['backlog', 'Backlog'],
      ['todo', 'TODO'],
      ['in-progress', 'in-progress'],
    ],
  );
});

test('parseLists drops duplicates and returns empty when empty', () => {
  assert.deepEqual(parseLists(['Todo', 'todo']).map((list) => list.id), ['todo']);
  assert.deepEqual(parseLists([]), []);
  assert.deepEqual(parseLists(undefined), []);
});

test('parseLists never exposes the reserved No status id as a list', () => {
  assert.deepEqual(parseLists(['__unassigned', 'todo']).map((list) => list.id), ['todo']);
});

test('buildBoardView names each column after its tag', () => {
  const view = buildBoardView([], { lists: parseLists(['Backlog', 'TODO']) });
  assert.deepEqual(
    view.lists.map((list) => [list.id, list.title, list.tag]),
    [
      [UNASSIGNED_LIST_ID, 'No status', null],
      ['backlog', 'Backlog', 'Backlog'],
      ['todo', 'TODO', 'TODO'],
    ],
  );
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
