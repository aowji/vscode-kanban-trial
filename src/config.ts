import * as vscode from 'vscode';
import { parseLists, type ParsedList } from './core/board';
import { DEFAULT_EXCLUDED_DIRS } from './core/scan';

export const CONFIG_SECTION = 'markdownKanban';

export interface BoardConfig {
  /** Default lists for new board files; the fallback when a board has no `lists` key. */
  lists: ParsedList[];
  excludeDirectories: string[];
  sortBy: 'updated' | 'title';
  showUnassigned: boolean;
  openMode: 'beside' | 'activeTab';
  maxFiles: number;
}

export function readConfig(): BoardConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    lists: parseLists(config.get<string[]>('defaultLists')),
    excludeDirectories: config.get<string[]>('excludeDirectories') ?? [...DEFAULT_EXCLUDED_DIRS],
    sortBy: config.get<string>('sortBy') === 'title' ? 'title' : 'updated',
    showUnassigned: config.get<boolean>('showUnassigned') ?? true,
    openMode: config.get<string>('openMode') === 'activeTab' ? 'activeTab' : 'beside',
    maxFiles: Math.max(50, config.get<number>('maxFiles') ?? 3000),
  };
}
