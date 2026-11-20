import type { ScannedCard } from './scan';

/** One board list (a column): a tag from the board file's `lists:` entry. */
export interface BoardList {
  /** Lower-cased tag; stable identity shared with the webview. */
  id: string;
  /** Tag as written in the board file; this is also the column name. */
  tag: string;
}

/** A scanned document plus the tags stored for it in the board file. */
export interface CardInput extends ScannedCard {
  tags: string[];
}

export interface CardView {
  /** Absolute path; identifies the card in the webview. */
  absPath: string;
  title: string;
  /** Path relative to the board file, shown on the card. */
  relPath: string;
  /** Tags other than the one that decides the list. */
  extraTags: string[];
  /** Tag that put the card in its list, `null` when it has none. */
  listTag: string | null;
  listId: string;
  summary: string;
  updated: number;
  error?: string;
}

interface ListView {
  id: string;
  /** What the column header shows: the tag, or "No status" for the bucket. */
  title: string;
  /** `null` for the "No status" bucket, which owns no tag. */
  tag: string | null;
  cards: CardView[];
}

export interface BoardView {
  lists: ListView[];
  totalCards: number;
}

export const UNASSIGNED_LIST_ID = '__unassigned';
export const UNASSIGNED_LIST_TITLE = 'No status';

/**
 * Trims entries, drops blanks and the reserved "No status" id, and keeps the
 * first spelling of a duplicated tag.
 */
export function parseLists(raw: readonly string[] | undefined): BoardList[] {
  const lists: BoardList[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim();
    if (!tag) continue;
    const id = tag.toLowerCase();
    if (id === UNASSIGNED_LIST_ID) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    lists.push({ id, tag });
  }
  return lists;
}

function indexLists(lists: readonly BoardList[]): Map<string, BoardList> {
  return new Map(lists.map((list) => [list.id, list]));
}

function firstListOf(
  tags: readonly string[],
  index: Map<string, BoardList>,
): BoardList | undefined {
  for (const tag of tags) {
    const hit = index.get(tag.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

interface BuildBoardOptions {
  lists: readonly BoardList[];
  sortBy?: 'updated' | 'title';
}

export function buildBoardView(
  cards: readonly CardInput[],
  options: BuildBoardOptions,
): BoardView {
  const { lists, sortBy = 'updated' } = options;
  const index = indexLists(lists);
  const buckets = new Map<string, CardView[]>(lists.map((list) => [list.id, []]));
  const unassigned: CardView[] = [];

  for (const card of cards) {
    const list = firstListOf(card.tags, index);
    const view: CardView = {
      absPath: card.absPath,
      title: card.title,
      relPath: card.relPath,
      extraTags: card.tags.filter((tag) => tag.toLowerCase() !== list?.tag.toLowerCase()),
      listTag: list?.tag ?? null,
      listId: list?.id ?? UNASSIGNED_LIST_ID,
      summary: card.summary,
      updated: card.updated,
      error: card.error,
    };
    (list ? buckets.get(list.id)! : unassigned).push(view);
  }

  const views: ListView[] = [
    {
      id: UNASSIGNED_LIST_ID,
      title: UNASSIGNED_LIST_TITLE,
      tag: null,
      cards: sortCards(unassigned, sortBy),
    },
  ];
  for (const list of lists) {
    views.push({
      id: list.id,
      title: list.tag,
      tag: list.tag,
      cards: sortCards(buckets.get(list.id) ?? [], sortBy),
    });
  }

  return { lists: views, totalCards: cards.length };
}

function sortCards(cards: CardView[], sortBy: 'updated' | 'title'): CardView[] {
  const copy = [...cards];
  copy.sort((a, b) => {
    if (sortBy === 'title') {
      const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      if (byTitle !== 0) return byTitle;
      return b.updated - a.updated;
    }
    if (b.updated !== a.updated) return b.updated - a.updated;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
  return copy;
}
