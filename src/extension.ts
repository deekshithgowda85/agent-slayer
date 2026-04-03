import * as vscode from 'vscode';
import { getConfig, migrateLegacyConfig, onConfigChange } from './config';
import { applyGlobalSettings, resetGlobalSettings } from './commands/applySettings';
import { installPromptFiles, getInstalledPrompts } from './commands/installPrompts';
import { registerChatParticipant } from './commands/chatParticipant';
import { SettingsEditorProvider } from './commands/settingsEditorProvider';
import { AgentSlayerSidebarProvider } from './commands/sidebarProvider';
import { AgentContextSwitcher } from './commands/contextSwitcher';
import { StackDetector } from './commands/stackDetector';
import { AgentSlayerMarketplaceProvider } from './commands/marketplaceProvider';
import { log, disposeChannel, getOutputChannel } from './utils/logger';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('Agent Slayer activating...');

  // Migrate legacy settings keys (copilotSkills.* -> agentSlayer.*) if needed.
  await migrateLegacyConfig();

  // ── Register settings editor tab + scheme ──
  try {
    context.subscriptions.push(SettingsEditorProvider.register(context));

    // Deep-link support: copilot-skills://settings
    context.subscriptions.push(
      vscode.window.registerUriHandler({
        handleUri: async (uri: vscode.Uri) => {
          try {
            if (uri.scheme === 'copilot-skills') {
              await SettingsEditorProvider.open();
            }
          } catch (err) {
            log(`URI handler error: ${String(err)}`);
          }
        },
      })
    );
  } catch (err) {
    log(`Custom settings editor registration failed: ${err}`);
  }

  // ── Sidebar + prompt-aware status bar/context switching ──
  try {
    context.subscriptions.push(AgentSlayerSidebarProvider.register(context));
  } catch (err) {
    log(`Sidebar registration failed: ${String(err)}`);
  }

  try {
    context.subscriptions.push(AgentSlayerMarketplaceProvider.register(context));
  } catch (err) {
    log(`Marketplace registration failed: ${String(err)}`);
  }

  try {
    await AgentContextSwitcher.initialize(context);
  } catch (err) {
    log(`Context switcher init failed: ${String(err)}`);
  }

  try {
    await StackDetector.initialize(context);
  } catch (err) {
    log(`Stack detector init failed: ${String(err)}`);
  }

  // ── Show setup UI on first install (as editor tab) ──
  await SettingsEditorProvider.showIfFirstInstall();

  // ── Auto-apply on startup (if already configured) ──
  const config = getConfig();
  if (config.autoInstallOnStartup) {
    const result = await installPromptFiles(context.extensionPath);
    await applyGlobalSettings(config);
    if (result.installed.length > 0) {
      vscode.window.showInformationMessage(
        `Agent Slayer: ${result.installed.length} prompt(s) updated.`
      );
    }
  }

  // ── Register commands ──
  context.subscriptions.push(

    // Open setup UI
    vscode.commands.registerCommand('copilotSkills.openSetup', () => {
      void SettingsEditorProvider.open();
    }),

    // Install without UI
    vscode.commands.registerCommand('copilotSkills.install', async () => {
      const cfg = getConfig();
      await applyGlobalSettings(cfg);
      await installPromptFiles(context.extensionPath);
      vscode.window.showInformationMessage('Agent Slayer: Instructions & prompts installed!');
    }),

    // Install prompts only
    vscode.commands.registerCommand('copilotSkills.installPrompts', async () => {
      const result = await installPromptFiles(context.extensionPath);
      vscode.window.showInformationMessage(
        `Installed: ${result.installed.length} | Skipped: ${result.skipped.length} | Errors: ${result.errors.length}`
      );
    }),

    // Reset
    vscode.commands.registerCommand('copilotSkills.reset', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all Copilot instructions?', 'Yes', 'Cancel'
      );
      if (confirm === 'Yes') {
        await resetGlobalSettings();
        vscode.window.showInformationMessage('Agent Slayer: Instructions reset.');
      }
    }),

    // Re-run setup
    vscode.commands.registerCommand('copilotSkills.rerunSetup', async () => {
      await SettingsEditorProvider.resetSetupState();
      await SettingsEditorProvider.open();
    }),

    // Status
    vscode.commands.registerCommand('copilotSkills.showStatus', async () => {
      const installed = await getInstalledPrompts();
      const cfg = getConfig();
      getOutputChannel().show();
      log(`Status — FE:${cfg.frontendFramework} Stack:${cfg.stack} DB:${cfg.database} CICD:[${cfg.cicd.join(',')}] MT:${cfg.multiTenant} Prompts:[${installed.join(', ')}]`);
    }),

    // Live config reload
    onConfigChange(async (newConfig) => {
      log('Config changed — reapplying...');
      await applyGlobalSettings(newConfig);
    })
  );

  // ── Register @skills chat participant ──
  registerChatParticipant(context, getConfig);

  log('Agent Slayer activated.');
}

export function deactivate(): void {
  log('Agent Slayer deactivating...');
  disposeChannel();
}
