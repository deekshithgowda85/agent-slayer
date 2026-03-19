import * as vscode from 'vscode';
import { Config } from '../config';
import {
  buildCodeInstructions,
  buildTestInstructions,
  buildReviewInstructions,
  COMMIT_INSTRUCTION,
} from '../config/instructionBuilder';
import { log } from '../utils/logger';

const TARGET = vscode.ConfigurationTarget.Global;

export async function applyGlobalSettings(config: Config): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Agent Slayer: Applying instructions...' },
    async () => {
      try {
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update('github.copilot.chat.codeGeneration.instructions', buildCodeInstructions(config), TARGET);
        await cfg.update('github.copilot.chat.testGeneration.instructions', buildTestInstructions(config), TARGET);
        await cfg.update('github.copilot.chat.reviewSelection.instructions', buildReviewInstructions(config), TARGET);
        await cfg.update('github.copilot.chat.commitMessageGeneration.instructions', [COMMIT_INSTRUCTION], TARGET);
        log(`Settings applied — stack:${config.stack} db:${config.database} mt:${config.multiTenant}`);
      } catch (err) {
        log(`Error applying settings: ${err}`);
        const retry = await vscode.window.showErrorMessage('Agent Slayer: Failed to apply instructions.', 'Retry');
        if (retry === 'Retry') await applyGlobalSettings(config);
      }
    }
  );
}

export async function resetGlobalSettings(): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration();
    await cfg.update('github.copilot.chat.codeGeneration.instructions', [], TARGET);
    await cfg.update('github.copilot.chat.testGeneration.instructions', [], TARGET);
    await cfg.update('github.copilot.chat.reviewSelection.instructions', [], TARGET);
    await cfg.update('github.copilot.chat.commitMessageGeneration.instructions', [], TARGET);
    log('Settings reset to defaults');
  } catch (err) {
    log(`Error resetting settings: ${err}`);
    vscode.window.showErrorMessage(`Agent Slayer: Reset failed — ${err}`);
  }
}
