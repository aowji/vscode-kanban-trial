import type { ScannedCard } from './scan';

export interface ParsedColumn {
  /** Lower-cased tag, stable identity used by the webview. */
  id: string;
  /** Tag as written in the board file. */
  tag: string;
  title: string;
}

/** A scanned document plus the tags stored for it in the board file. */
export interface BoardCardInput extends ScannedCard {
  tags: string[];
}

export interface CardView {
  id: string;
  title: string;
  path: string;
  /** Tags other than the column tag. */
  tags: string[];
  statusTag: string | null;
  columnId: string;
  summary: string;
  updated: number;
  error?: string;
}

export interface ColumnView {
  id: string;
  title: string;
  tag: string | null;
  cards: CardView[];
}

export interface BoardView {
  columns: ColumnView[];
  totalCards: number;
}

export const UNASSIGNED_COLUMN_ID = '__unassigned';
export const UNASSIGNED_COLUMN_TITLE = 'No status';

/** `in-progress` -> `In Progress`, `TODO` -> `TODO`. */
export function titleForTag(tag: string): string {
  if (/[A-Z]/.test(tag) && tag === tag.toUpperCase()) return tag;
  return tag
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Accepts `tag` or `tag:Display Title` entries. */
export function parseColumns(raw: readonly string[] | undefined): ParsedColumn[] {
  const columns: ParsedColumn[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const tag = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    if (!tag) continue;
    const id = tag.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const customTitle = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    columns.push({ id, tag, title: customTitle || titleForTag(tag) });
  }
  return columns;
}

/** `tag`, or `tag:Display Title` when the title is not just the prettified tag. */
export function formatColumnEntry(column: ParsedColumn): string {
  return column.title === titleForTag(column.tag) ? column.tag : `${column.tag}:${column.title}`;
}

/**
 * The board file owns its own lists; the workspace setting is only the fallback
 * when the board file does not define a `lists` key at all.
 */
export function resolveColumns(
  fromBoard: readonly string[] | undefined,
  fallback: readonly ParsedColumn[],
): ParsedColumn[] {
  return fromBoard !== undefined ? parseColumns(fromBoard) : [...fallback];
}

/** The first tag that belongs to a column, or `null` when there is none. */
export function statusTagOf(tags: readonly string[], columns: readonly ParsedColumn[]): string | null {
  const byId = new Map(columns.map((column) => [column.id, column.tag]));
  for (const tag of tags) {
    const hit = byId.get(tag.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export interface BuildBoardOptions {
  columns: readonly ParsedColumn[];
  sortBy?: 'updated' | 'title';
  showUnassigned?: boolean;
}

export function buildBoardView(
  cards: readonly BoardCardInput[],
  options: BuildBoardOptions,
): BoardView {
  const { columns, sortBy = 'updated', showUnassigned = true } = options;
  const buckets = new Map<string, CardView[]>(columns.map((column) => [column.id, []]));
  const unassigned: CardView[] = [];

  for (const card of cards) {
    const statusTag = statusTagOf(card.tags, columns);
    const columnId = statusTag ? columns.find((column) => column.id === statusTag.toLowerCase())!.id : UNASSIGNED_COLUMN_ID;
    const view: CardView = {
      id: card.absPath,
      title: card.title,
      path: card.relPath,
      tags: card.tags.filter((tag) => tag.toLowerCase() !== statusTag?.toLowerCase()),
      statusTag,
      columnId,
      summary: card.summary,
      updated: card.updated,
      error: card.error,
    };
    (buckets.get(columnId) ?? unassigned).push(view);
  }

  const views: ColumnView[] = [];
  if (showUnassigned) {
    views.push({
      id: UNASSIGNED_COLUMN_ID,
      title: UNASSIGNED_COLUMN_TITLE,
      tag: null,
      cards: sortCards(unassigned, sortBy),
    });
  }
  for (const column of columns) {
    views.push({
      id: column.id,
      title: column.title,
      tag: column.tag,
      cards: sortCards(buckets.get(column.id) ?? [], sortBy),
    });
  }

  return { columns: views, totalCards: cards.length };
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
