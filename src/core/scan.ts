import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { readFrontmatter } from './frontmatter';

export const DEFAULT_IGNORED_DIRS: readonly string[] = [
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

export const MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown'];

export interface ScanRoot {
  label: string;
  dir: string;
}

export interface ScanOptions {
  ignoredDirs?: readonly string[];
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

export function toPosix(value: string): string {
  return value.split(nodePath.sep).join('/');
}

/** Recursively collects Markdown files, skipping well-known vendor directories. */
export async function collectMarkdownFiles(
  root: string,
  options: ScanOptions = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const ignored = new Set((options.ignoredDirs ?? DEFAULT_IGNORED_DIRS).map((dir) => dir.toLowerCase()));
  const maxFiles = Math.max(1, options.maxFiles ?? 3000);
  const files: string[] = [];
  const pending: string[] = [root];

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
        if (!ignored.has(entry.name.toLowerCase())) pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!MARKDOWN_EXTENSIONS.includes(nodePath.extname(entry.name).toLowerCase())) continue;
      files.push(full);
      if (files.length >= maxFiles) {
        return { files: files.sort(), truncated: true };
      }
    }
  }

  return { files: files.sort(), truncated: false };
}

export async function scanWorkspace(
  roots: readonly ScanRoot[],
  options: ScanOptions = {},
): Promise<ScanResult> {
  const readText = options.readText ?? ((absPath: string) => fs.readFile(absPath, 'utf8'));
  const cards: ScannedCard[] = [];
  let fileCount = 0;
  let truncated = false;

  for (const root of roots) {
    const collected = await collectMarkdownFiles(root.dir, options);
    truncated = truncated || collected.truncated;

    for (const absPath of collected.files) {
      fileCount += 1;
      const relative = toPosix(nodePath.relative(root.dir, absPath));
      const relPath = roots.length > 1 ? `${root.label}/${relative}` : relative;
      let text: string;
      let updated: number;
      try {
        [text, updated] = await Promise.all([readText(absPath), modifiedTime(absPath)]);
      } catch {
        continue;
      }

      const info = readFrontmatter(text);
      cards.push({
        absPath,
        relPath,
        title: deriveTitle(info.data, info.body, nodePath.basename(absPath)),
        summary: deriveSummary(info.body),
        updated,
        error: info.error,
      });
    }
  }

  return { cards, fileCount, truncated };
}

async function modifiedTime(absPath: string): Promise<number> {
  try {
    return (await fs.stat(absPath)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Front matter `title`, then the first level-1 heading, then the file name. */
export function deriveTitle(
  data: Record<string, unknown>,
  body: string,
  fileName: string,
): string {
  for (const key of ['title', 'name']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const heading = /^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading && heading[1].trim()) return heading[1].trim();
  return fileName.replace(/\.(markdown|md)$/i, '');
}

/** First paragraph of the body, stripped of Markdown noise and truncated. */
export function deriveSummary(body: string, maxLength = 200): string {
  const parts: string[] = [];
  let started = false;
  let inFence = false;

  for (const raw of body.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
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
    started = true;
    parts.push(cleanInline(line));
    if (parts.join(' ').length > maxLength) break;
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;

  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const keep = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${keep.trimEnd()}…`;
}

function cleanInline(line: string): string {
  return line
    .replace(/^>\s*/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}
