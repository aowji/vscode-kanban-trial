import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.idea',
  '.vscode',
];

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

interface ScanOptions {
  excludeDirectories?: readonly string[];
  maxFiles?: number;
  /** Returns file contents; lets the caller prefer unsaved editor buffers. */
  readText?: (absPath: string) => Promise<string>;
}

export interface ScannedCard {
  absPath: string;
  relPath: string;
  title: string;
  summary: string;
  /** Last modification time in milliseconds. */
  updated: number;
  error?: string;
}

export interface ScanResult {
  cards: ScannedCard[];
  fileCount: number;
  truncated: boolean;
}

export function toPosixPath(value: string): string {
  return value.split(nodePath.sep).join('/');
}

/** Recursively collects Markdown files, skipping well-known vendor directories. */
export async function collectMarkdownFiles(
  directory: string,
  options: ScanOptions = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const excluded = new Set(
    (options.excludeDirectories ?? DEFAULT_EXCLUDED_DIRS).map((dir) => dir.toLowerCase()),
  );
  const maxFiles = Math.max(1, options.maxFiles ?? 3000);
  const files: string[] = [];
  const pending: string[] = [directory];

  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name.toLowerCase())) pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MARKDOWN_EXTENSIONS.has(nodePath.extname(entry.name).toLowerCase())) continue;
      files.push(full);
      if (files.length >= maxFiles) return { files: files.sort(), truncated: true };
    }
  }

  return { files: files.sort(), truncated: false };
}

/** Reads every Markdown document under `directory` and derives its card fields. */
export async function scanDirectory(
  directory: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const readText = options.readText ?? ((absPath: string) => fs.readFile(absPath, 'utf8'));
  const collected = await collectMarkdownFiles(directory, options);
  const cards: ScannedCard[] = [];
  let fileCount = 0;

  for (const absPath of collected.files) {
    fileCount += 1;
    let text: string;
    let updated: number;
    try {
      [text, updated] = await Promise.all([readText(absPath), modifiedTime(absPath)]);
    } catch {
      continue;
    }

    const { body, error } = stripFrontmatter(text);
    cards.push({
      absPath,
      relPath: toPosixPath(nodePath.relative(directory, absPath)),
      title: deriveTitle(body, nodePath.basename(absPath)),
      summary: deriveSummary(body),
      updated,
      error,
    });
  }

  return { cards, fileCount, truncated: collected.truncated };
}

async function modifiedTime(absPath: string): Promise<number> {
  try {
    return (await fs.stat(absPath)).mtimeMs;
  } catch {
    return 0;
  }
}

const LEADING_FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const UNCLOSED_FRONTMATTER = /^---[ \t]*\r?\n/;

/**
 * Removes a leading YAML front matter block. The board shows document text, so
 * metadata is dropped rather than parsed; an unclosed block is reported instead
 * of silently swallowing the whole document.
 */
export function stripFrontmatter(text: string): { body: string; error?: string } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = LEADING_FRONTMATTER.exec(body);
  if (match) return { body: body.slice(match[0].length) };
  return UNCLOSED_FRONTMATTER.test(body)
    ? { body, error: 'Front matter starts with "---" but has no closing line.' }
    : { body };
}

/** First level-1 heading outside fenced code, then the file name. */
export function deriveTitle(body: string, fileName: string): string {
  let inFence = false;
  for (const line of body.split(/\r\n|\n|\r/)) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading && heading[1].trim()) return heading[1].trim();
  }
  const extension = nodePath.extname(fileName).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(extension) ? fileName.slice(0, -extension.length) : fileName;
}

function isFenceLine(line: string): boolean {
  return /^(```|~~~)/.test(line.trim());
}

/** First paragraph of the body, stripped of Markdown noise and truncated. */
export function deriveSummary(body: string, maxLength = 200): string {
  const parts: string[] = [];
  let started = false;
  let inFence = false;
  let length = 0;

  for (const raw of body.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (isFenceLine(line)) {
      if (started) break;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (started) break;
      continue;
    }
    const isHeading = /^#{1,6}\s/.test(line);
    const isRule = /^([-*_])\1{2,}$/.test(line);
    if (isHeading || isRule || line.startsWith('|') || line.startsWith('<!--')) {
      if (started) break;
      continue;
    }
    const cleaned = cleanInline(line);
    started = true;
    length += cleaned.length + (parts.length ? 1 : 0);
    parts.push(cleaned);
    if (length > maxLength) break;
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const keep = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${keep.trimEnd()}…`;
}

function cleanInline(line: string): string {
  // Inline code must survive emphasis stripping, otherwise `__init__` or
  // `snake_case` would lose their underscores; park each span and restore it.
  const code: string[] = [];
  const text = line
    .replace(/`([^`]+)`/g, (_, value: string) => {
      code.push(value);
      return `\u0000${code.length - 1}\u0000`;
    })
    .replace(/^>\s*/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    // Underscore emphasis may not start or end inside a word, which keeps
    // snake_case and file_name.md intact.
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, '$1');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]).trim();
}
