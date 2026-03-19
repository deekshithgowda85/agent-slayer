import * as vscode from 'vscode';
import { Config } from '../config';

export function createStatusBar(
  context: vscode.ExtensionContext,
  getConfig: () => Config
): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  item.command = 'copilotSkills.openSetup';
  item.tooltip = 'Agent Slayer — Click to open settings';

  function update(config: Config): void {
    item.text = `⚡ ${config.stack} · ${config.database}`;
  }

  update(getConfig());
  item.show();

  context.subscriptions.push(item);
  return item;
}
