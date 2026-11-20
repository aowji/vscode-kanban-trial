import { parseDocument } from 'yaml';

export interface FrontmatterInfo {
  /** Front matter parsed into a plain object; empty when absent or invalid. */
  data: Record<string, unknown>;
  /** Raw YAML between the fences; `null` when the file has no front matter. */
  block: string | null;
  /** Everything after the closing fence. */
  body: string;
  error?: string;
}

const OPEN_FENCE = /^---[ \t]*(?:\r\n|\n|\r)/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const EOL = /\r\n|\n|\r/;

/**
 * Splits a Markdown document into front matter and body. Read only: the board
 * never rewrites documents, it just borrows `title` for the card heading.
 */
export function readFrontmatter(text: string): FrontmatterInfo {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const rest = text.slice(bom);
  const open = OPEN_FENCE.exec(rest);
  if (!open) return { data: {}, block: null, body: rest };

  const blockStart = open[0].length;
  let lineStart = blockStart;
  while (lineStart <= rest.length) {
    const match = EOL.exec(rest.slice(lineStart));
    const lineEnd = match ? lineStart + match.index : rest.length;
    const line = rest.slice(lineStart, lineEnd);
    if (CLOSE_FENCE.test(line)) {
      const newlineLength = match ? match[0].length : 0;
      const block = rest.slice(blockStart, lineStart);
      const bodyOffset = lineEnd + newlineLength;
      const parsed = parseYamlBlock(block);
      return { data: parsed.data, block, body: rest.slice(bodyOffset), error: parsed.error };
    }
    if (!match) break;
    lineStart = lineEnd + match[0].length;
  }

  return {
    data: {},
    block: null,
    body: rest,
    error: 'Unterminated front matter: no closing "---" line was found.',
  };
}

function parseYamlBlock(block: string): { data: Record<string, unknown>; error?: string } {
  if (!block.trim()) return { data: {} };
  try {
    const doc = parseDocument(block, { prettyErrors: false });
    if (doc.errors.length > 0) {
      return { data: {}, error: `Invalid front matter: ${doc.errors[0].message.split('\n')[0]}` };
    }
    const js = doc.toJS();
    if (!js || typeof js !== 'object' || Array.isArray(js)) {
      return { data: {}, error: 'Front matter must be a YAML mapping.' };
    }
    return { data: js as Record<string, unknown> };
  } catch (error) {
    return { data: {}, error: `Invalid front matter: ${(error as Error).message}` };
  }
}
