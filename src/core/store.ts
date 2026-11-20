import { Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from 'yaml';
import { parseColumns } from './board';

export const BOARD_FILE_SUFFIXES = ['.kb.yaml', '.kb.yml'] as const;
export const DEFAULT_BOARD_FILE_NAME = 'kanban.kb.yaml';
export const BOARD_VERSION = 1;

export function isBoardFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return BOARD_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Card keys are POSIX paths relative to the board file's folder. */
export function normalizeCardPath(value: string): string {
  return value
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

export interface BoardData {
  /** Card path -> tags. */
  tags: Map<string, string[]>;
  /** List definitions owned by this board, `undefined` when the file has none. */
  lists?: string[];
  error?: string;
}

/**
 * Reads the board file. Hand-written entries are tolerated in several shapes:
 * `tags: [a]`, `tags: "a, b"`, a bare list, or no value at all.
 */
export function readBoard(text: string): BoardData {
  const tags = new Map<string, string[]>();
  if (!text.trim()) return { tags };

  let doc;
  try {
    doc = parseDocument(text, { prettyErrors: false });
  } catch (error) {
    return { tags, error: `Invalid board file: ${(error as Error).message}` };
  }
  if (doc.errors.length > 0) {
    return { tags, error: `Invalid board file: ${doc.errors[0].message.split('\n')[0]}` };
  }

  const data = doc.toJS();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { tags, error: 'The board file must be a YAML mapping.' };
  }

  const lists = readLists((data as Record<string, unknown>).lists);
  const cards = (data as Record<string, unknown>).cards;
  if (!cards || typeof cards !== 'object' || Array.isArray(cards)) return { tags, lists };

  for (const [key, value] of Object.entries(cards as Record<string, unknown>)) {
    tags.set(normalizeCardPath(key), entryTags(value));
  }
  return { tags, lists };
}

/** `lists: [todo, "in-progress:In Progress"]` or `- {tag: todo, title: Todo}`. */
function readLists(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lists: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const text = String(entry).trim();
      if (text) lists.push(text);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const { tag, name, title } = entry as { tag?: unknown; name?: unknown; title?: unknown };
    const tagText = typeof tag === 'string' ? tag.trim() : typeof name === 'string' ? name.trim() : '';
    if (!tagText) continue;
    const titleText = typeof title === 'string' ? title.trim() : '';
    lists.push(titleText ? `${tagText}:${titleText}` : tagText);
  }
  return lists;
}

function entryTags(value: unknown): string[] {
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
  const key = normalizeCardPath(relPath);
  const doc = text.trim() ? parseDocument(text) : new Document({});
  if (doc.errors.length > 0) {
    throw new Error(`Invalid board file: ${doc.errors[0].message.split('\n')[0]}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error('The board file must be a YAML mapping.');
  }

  if (!doc.has('version')) doc.set('version', BOARD_VERSION);
  // `set(key, {})` would store a plain object node, which `setIn` cannot descend into.
  if (!isMap(doc.get('cards', true))) doc.set('cards', new YAMLMap());

  if (tags.length === 0) doc.deleteIn(['cards', key]);
  else doc.setIn(['cards', key], { tags });

  for (const path of [['cards'], ['cards', key], ['cards', key, 'tags']]) {
    const node = doc.getIn(path, true) as { flow?: boolean } | undefined;
    if (node && typeof node === 'object' && 'flow' in node) node.flow = false;
  }

  const next = toFileText(doc.toString({ lineWidth: 0 }));
  if (next === text) return { text, start: 0, end: 0, newText: '', changed: false };
  return { text: next, ...minimalEdit(text, next), changed: true };
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
  const parsedEntry = parseColumns([entry])[0];
  if (!parsedEntry) {
    throw new Error('List name cannot be empty.');
  }

  const doc = parseBoardForWrite(text);
  if (!doc.has('version')) doc.set('version', BOARD_VERSION);
  const seq = ensureListsSeq(doc, options.fallbackLists ?? []);

  const existing = parseColumns(seqToStrings(seq));
  if (existing.some((col) => col.id === parsedEntry.id)) {
    throw new Error(`List "${parsedEntry.tag}" already exists.`);
  }

  const node = doc.createNode(entry.trim());
  const index = clampIndex(options.index, seq.items.length);
  seq.items.splice(index, 0, node);
  seq.flow = false;
  if (!isMap(doc.get('cards', true))) doc.set('cards', new YAMLMap());

  const next = toFileText(doc.toString({ lineWidth: 0 }));
  if (next === text) return { text, start: 0, end: 0, newText: '', changed: false };
  return { text: next, ...minimalEdit(text, next), changed: true };
}

/**
 * Reorders a list to `toIndex`, the final 0-based position in `lists:`.
 * Cards are untouched: only the order of the columns changes.
 */
export function moveBoardList(
  text: string,
  columnId: string,
  toIndex: number,
): StoreUpdate {
  const targetId = columnId.trim().toLowerCase();
  const doc = parseBoardForWrite(text);
  const existing = doc.get('lists', true);
  if (!isSeq(existing)) return { text, start: 0, end: 0, newText: '', changed: false };

  const from = existing.items.findIndex((item) => {
    const raw = itemToString(item);
    const col = raw ? parseColumns([raw])[0] : undefined;
    return col?.id === targetId;
  });
  if (from === -1) return { text, start: 0, end: 0, newText: '', changed: false };

  const to = clampIndex(toIndex, existing.items.length - 1);
  if (to === from) return { text, start: 0, end: 0, newText: '', changed: false };

  const [node] = existing.items.splice(from, 1);
  existing.items.splice(to, 0, node);
  if (!isMap(doc.get('cards', true))) doc.set('cards', new YAMLMap());

  const next = toFileText(doc.toString({ lineWidth: 0 }));
  if (next === text) return { text, start: 0, end: 0, newText: '', changed: false };
  return { text: next, ...minimalEdit(text, next), changed: true };
}

function clampIndex(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

/**
 * Removes a list from the board file. Cards that carried that tag keep it in
 * `cards:` (showing up under "No status" with the tag as a chip), so removing
 * a list is non-destructive.
 */
export function removeBoardList(
  text: string,
  columnId: string,
  fallbackLists: readonly string[] = [],
): StoreUpdate {
  const targetId = columnId.trim().toLowerCase();
  const doc = parseBoardForWrite(text);
  if (!doc.has('version')) doc.set('version', BOARD_VERSION);
  const seq = ensureListsSeq(doc, fallbackLists);

  let removed = false;
  for (let i = seq.items.length - 1; i >= 0; i -= 1) {
    const raw = itemToString(seq.items[i]);
    const col = raw ? parseColumns([raw])[0] : undefined;
    if (col && col.id === targetId) {
      seq.items.splice(i, 1);
      removed = true;
    }
  }
  if (!removed) return { text, start: 0, end: 0, newText: '', changed: false };

  seq.flow = seq.items.length === 0;
  if (!isMap(doc.get('cards', true))) doc.set('cards', new YAMLMap());

  const next = toFileText(doc.toString({ lineWidth: 0 }));
  if (next === text) return { text, start: 0, end: 0, newText: '', changed: false };
  return { text: next, ...minimalEdit(text, next), changed: true };
}

function parseBoardForWrite(text: string): Document {
  const doc = text.trim() ? parseDocument(text) : new Document({});
  if (doc.errors.length > 0) {
    throw new Error(`Invalid board file: ${doc.errors[0].message.split('\n')[0]}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error('The board file must be a YAML mapping.');
  }
  return doc;
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

function seqToStrings(seq: YAMLSeq): string[] {
  const out: string[] = [];
  for (const item of seq.items) {
    const s = itemToString(item);
    if (s) out.push(s);
  }
  return out;
}

function itemToString(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const node = item as { toJSON?: () => unknown; value?: unknown };
  const val = typeof node.toJSON === 'function' ? node.toJSON() : node.value;
  if (typeof val === 'string' || typeof val === 'number') {
    const text = String(val).trim();
    return text || undefined;
  }
  if (val && typeof val === 'object') {
    const { tag, name, title } = val as { tag?: unknown; name?: unknown; title?: unknown };
    const tagText = typeof tag === 'string' ? tag.trim() : typeof name === 'string' ? name.trim() : '';
    if (!tagText) return undefined;
    const titleText = typeof title === 'string' ? title.trim() : '';
    return titleText ? `${tagText}:${titleText}` : tagText;
  }
  return undefined;
}

function toFileText(value: string): string {
  if (!value) return '';
  return value.endsWith('\n') ? value : `${value}\n`;
}

/** Narrows a whole-file replacement down to the region that actually changed. */
export function minimalEdit(before: string, after: string): { start: number; end: number; newText: string } {
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
