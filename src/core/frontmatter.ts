import { parseDocument } from 'yaml';

export interface FrontmatterInfo {
  /** Front matter parsed into a plain object; empty when absent or invalid. */
  data: Record<string, unknown>;
  /** Everything after the closing fence. */
  body: string;
  error?: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const UNTERMINATED = /^---[ \t]*\r?\n/;

/**
 * Splits a Markdown document into front matter and body. Read only: the board
 * never rewrites documents, it just borrows `title` for the card heading.
 */
export function readFrontmatter(text: string): FrontmatterInfo {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = FRONTMATTER.exec(body);
  if (!match) {
    return UNTERMINATED.test(body)
      ? { data: {}, body, error: 'Unterminated front matter: no closing "---" line was found.' }
      : { data: {}, body };
  }
  const parsed = parseYamlBlock(match[1] ?? '');
  return { data: parsed.data, body: body.slice(match[0].length), error: parsed.error };
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
