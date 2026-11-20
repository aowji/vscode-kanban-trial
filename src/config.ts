import * as vscode from 'vscode';
import { parseLists, type BoardList } from './core/board';
import { DEFAULT_EXCLUDED_DIRS } from './core/scan';

export const CONFIG_SECTION = 'markdownKanban';

interface BoardConfig {
  /** Default lists for new board files; the fallback when a board has no `lists` key. */
  lists: BoardList[];
  excludeDirectories: string[];
  sortBy: 'updated' | 'title';
  openMode: 'beside' | 'activeTab';
  maxFiles: number;
}

export function readConfig(): BoardConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    lists: parseLists(config.get<string[]>('defaultLists')),
    excludeDirectories: config.get<string[]>('excludeDirectories') ?? [...DEFAULT_EXCLUDED_DIRS],
    sortBy: config.get<string>('sortBy') === 'title' ? 'title' : 'updated',
    openMode: config.get<string>('openMode') === 'activeTab' ? 'activeTab' : 'beside',
    maxFiles: config.get<number>('maxFiles') ?? 3000,
  };
}
