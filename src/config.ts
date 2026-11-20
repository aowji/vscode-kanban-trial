import * as vscode from 'vscode';
import { parseColumns, type ParsedColumn } from './core/board';
import { DEFAULT_IGNORED_DIRS } from './core/scan';

export const CONFIG_SECTION = 'markdownKanban';

export interface BoardConfig {
  columns: ParsedColumn[];
  ignoredDirs: string[];
  sortBy: 'updated' | 'title';
  showUnassigned: boolean;
  openMode: 'beside' | 'activeTab';
  maxFiles: number;
}

export function readConfig(): BoardConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    columns: parseColumns(config.get<string[]>('columns')),
    ignoredDirs: config.get<string[]>('excludeDirectories') ?? [...DEFAULT_IGNORED_DIRS],
    sortBy: config.get<string>('sortBy') === 'title' ? 'title' : 'updated',
    showUnassigned: config.get<boolean>('showUnassigned') ?? true,
    openMode: config.get<string>('openMode') === 'activeTab' ? 'activeTab' : 'beside',
    maxFiles: Math.max(50, config.get<number>('maxFiles') ?? 3000),
  };
}
