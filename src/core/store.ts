import { Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from 'yaml';
import { parseLists, type BoardList } from './board';

const BOARD_FILE_SUFFIXES = ['.kb.yaml', '.kb.yml'] as const;
export const DEFAULT_BOARD_FILE_NAME = 'kanban.kb.yaml';
const BOARD_VERSION = 1;

export function isBoardFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return BOARD_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Card keys are POSIX paths relative to the board file's folder. */
export function toCardKey(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function normalizeTags(value: unknown): string[] {
  const tags: string[] = [];
  const push = (candidate: unknown): void => {
    if (candidate === null || candidate === undefined) return;
    const tag = String(candidate).trim();
    if (!tag) return;
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    tags.push(tag);
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (typeof value === 'string') value.split(',').forEach(push);
  else push(value);
  return tags;
}

export interface BoardFile {
  /** Card path -> tags. */
  cardTags: Map<string, string[]>;
  /** Lists owned by this board, `undefined` when the file has no `lists` key. */
  lists?: BoardList[];
  error?: string;
}

/**
 * Reads the board file. Hand-written entries are tolerated in several shapes:
 * `tags: [a]`, `tags: "a, b"`, a bare list, or no value at all.
 */
export function readBoard(text: string): BoardFile {
  const cardTags = new Map<string, string[]>();
  if (!text.trim()) return { cardTags };

  const parsed = parseBoardDoc(text);
  if ('error' in parsed) return { cardTags, error: parsed.error };

  const data = parsed.doc.toJS();
  if (!data || typeof data !== 'object') return { cardTags };

  const record = data as Record<string, unknown>;
  const entries = readLists(record.lists);
  const lists = entries === undefined ? undefined : parseLists(entries);
  const cards = record.cards;
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) return { cardTags, lists };

  for (const [key, value] of Object.entries(cards as Record<string, unknown>)) {
    cardTags.set(toCardKey(key), cardTagsFromEntry(value));
  }
  return { cardTags, lists };
}

/** `lists: [todo, "in-progress:In Progress"]` or `- {tag: todo, title: Todo}`. */
function readLists(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lists: string[] = [];
  for (const entry of value) {
    const text = valueToListEntry(entry);
    if (text) lists.push(text);
  }
  return lists;
}

function cardTagsFromEntry(value: unknown): string[] {
  if (Array.isArray(value) || typeof value === 'string') return normalizeTags(value);
  if (value && typeof value === 'object') return normalizeTags((value as { tags?: unknown }).tags);
  return [];
}

export interface StoreUpdate {
  text: string;
  /** Offsets of the replaced region in the original text. */
  start: number;
  end: number;
  newText: string;
  changed: boolean;
}

/**
 * Sets the tags of one card in the board file. Only that entry is rewritten:
 * everything else, comments included, round-trips through the YAML document.
 */
export function setCardTags(text: string, relPath: string, tags: string[]): StoreUpdate {
  const key = toCardKey(relPath);
  const doc = parseBoardForWrite(text);
  ensureBoardShape(doc);

  if (tags.length === 0) doc.deleteIn(['cards', key]);
  else doc.setIn(['cards', key], { tags });

  for (const path of [['cards'], ['cards', key], ['cards', key, 'tags']]) {
    const node = doc.getIn(path, true) as { flow?: boolean } | undefined;
    if (node && typeof node === 'object' && 'flow' in node) node.flow = false;
  }

  return finishUpdate(doc, text);
}

export interface AddListOptions {
  /** Insert position among lists (0-based). Appended when omitted. */
  index?: number;
  /** Lists used to seed `lists:` when the board file has no such key yet. */
  fallbackLists?: readonly string[];
}

/** Adds a list entry to the board file, preserving existing lists, cards and comments. */
export function addBoardList(
  text: string,
  entry: string,
  options: AddListOptions = {},
): StoreUpdate {
  const parsed = parseLists([entry])[0];
  if (!parsed) throw new Error('List name cannot be empty.');

  const doc = parseBoardForWrite(text);
  const seq = ensureListsSeq(doc, options.fallbackLists ?? []);
  const existing = seq.items.map(nodeToListEntry).filter((entry): entry is string => !!entry);
  if (parseLists(existing).some((list) => list.id === parsed.id)) {
    throw new Error(`List "${parsed.tag}" already exists.`);
  }

  seq.items.splice(clampIndex(options.index, seq.items.length), 0, doc.createNode(entry.trim()));
  seq.flow = false;
  ensureBoardShape(doc);
  return finishUpdate(doc, text);
}

/**
 * Reorders a list to `toIndex`, its final 0-based position in `lists:`.
 * Cards are untouched: only the order of the columns changes.
 */
export function moveBoardList(text: string, listId: string, toIndex: number): StoreUpdate {
  const targetId = listId.trim().toLowerCase();
  const doc = parseBoardForWrite(text);
  const seq = doc.get('lists', true);
  if (!isSeq(seq)) return noChange(text);

  const from = seq.items.findIndex((item) => {
    const entry = nodeToListEntry(item);
    return entry ? parseLists([entry])[0]?.id === targetId : false;
  });
  if (from === -1) return noChange(text);

  const to = clampIndex(toIndex, seq.items.length - 1);
  if (to === from) return noChange(text);

  const [node] = seq.items.splice(from, 1);
  seq.items.splice(to, 0, node);
  ensureBoardShape(doc);
  return finishUpdate(doc, text);
}

/**
 * Removes a list from the board file. Cards that carried that tag keep it in
 * `cards:` (showing up under "No status" with the tag as a chip), so removing
 * a list is non-destructive.
 */
export function removeBoardList(
  text: string,
  listId: string,
  fallbackLists: readonly string[] = [],
): StoreUpdate {
  const targetId = listId.trim().toLowerCase();
  const doc = parseBoardForWrite(text);
  const seq = ensureListsSeq(doc, fallbackLists);

  let removed = false;
  for (let i = seq.items.length - 1; i >= 0; i -= 1) {
    const entry = nodeToListEntry(seq.items[i]);
    if (entry && parseLists([entry])[0]?.id === targetId) {
      seq.items.splice(i, 1);
      removed = true;
    }
  }
  if (!removed) return noChange(text);

  seq.flow = seq.items.length === 0;
  ensureBoardShape(doc);
  return finishUpdate(doc, text);
}

function noChange(text: string): StoreUpdate {
  return { text, start: 0, end: 0, newText: '', changed: false };
}

/** Parses a board file, reporting problems instead of throwing. */
function parseBoardDoc(text: string): { doc: Document } | { error: string } {
  let doc: Document;
  try {
    doc = text.trim() ? parseDocument(text, { prettyErrors: false }) : new Document({});
  } catch (error) {
    return { error: `Invalid board file: ${(error as Error).message}` };
  }
  if (doc.errors.length > 0) {
    return { error: `Invalid board file: ${doc.errors[0].message.split('\n')[0]}` };
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    return { error: 'The board file must be a YAML mapping.' };
  }
  return { doc };
}

function parseBoardForWrite(text: string): Document {
  const parsed = parseBoardDoc(text);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.doc;
}

function ensureBoardShape(doc: Document): void {
  if (!doc.has('version')) doc.set('version', BOARD_VERSION);
  // `set(key, {})` stores a plain object node, which `setIn` cannot descend into.
  if (!isMap(doc.get('cards', true))) doc.set('cards', new YAMLMap());
}

function ensureListsSeq(doc: Document, fallbackLists: readonly string[]): YAMLSeq {
  const existing = doc.get('lists', true);
  if (isSeq(existing)) return existing;
  const seq = new YAMLSeq();
  for (const item of fallbackLists) seq.add(doc.createNode(item));
  seq.flow = seq.items.length === 0;
  doc.set('lists', seq);
  return seq;
}

function clampIndex(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function finishUpdate(doc: Document, before: string): StoreUpdate {
  const text = toFileText(doc.toString({ lineWidth: 0 }));
  if (text === before) return noChange(before);
  return { text, ...minimalEdit(before, text), changed: true };
}

/** YAML node for a list entry; `{tag, title}` objects are accepted too. */
function nodeToListEntry(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const typed = node as { toJSON?: () => unknown; value?: unknown };
  const value = typeof typed.toJSON === 'function' ? typed.toJSON() : typed.value;
  return valueToListEntry(value);
}

/** Plain value for a list entry; shared by file reads and YAML node reads. */
function valueToListEntry(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim() || undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const { tag, name, title } = value as { tag?: unknown; name?: unknown; title?: unknown };
  const tagText = typeof tag === 'string' ? tag.trim() : typeof name === 'string' ? name.trim() : '';
  if (!tagText) return undefined;
  const titleText = typeof title === 'string' ? title.trim() : '';
  return titleText ? `${tagText}:${titleText}` : tagText;
}

function toFileText(value: string): string {
  if (!value) return '';
  return value.endsWith('\n') ? value : `${value}\n`;
}

/** Narrows a whole-file replacement down to the region that actually changed. */
export function minimalEdit(
  before: string,
  after: string,
): { start: number; end: number; newText: string } {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    start: prefix,
    end: before.length - suffix,
    newText: after.slice(prefix, after.length - suffix),
  };
}

export function boardFileTemplate(lists: readonly string[] = []): string {
  const lines = [
    '# Markdown Kanban board.',
    '# Every document in this folder becomes a card; card status is stored here,',
    '# never in the documents themselves.',
    '# Add lists here (or from the board UI). Use "tag:Display Title" to rename a column.',
    `version: ${BOARD_VERSION}`,
  ];
  if (lists.length > 0) {
    lines.push('lists:');
    for (const entry of lists) lines.push(`  - ${quoteYamlScalar(entry)}`);
  } else {
    lines.push('lists: []');
  }
  lines.push('cards: {}', '');
  return lines.join('\n');
}

/** Quotes only when needed, e.g. `in-progress:In Progress` would read as a mapping. */
function quoteYamlScalar(value: string): string {
  return /[:#]/.test(value) || /^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}
