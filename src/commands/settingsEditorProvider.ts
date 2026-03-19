import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config';
import { applyGlobalSettings } from './applySettings';
import { installPromptFiles } from './installPrompts';
import { log } from '../utils/logger';

const SETUP_DONE_KEY = 'copilotSkills.setupCompleted';
const VIEW_TYPE = 'copilotSkills.settingsEditor';
const SETTINGS_DOC_URI = 'untitled:copilot-skills-settings';

class CopilotSkillsSettingsDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose(): void {
    // No-op: readonly virtual document.
  }
}

interface SetupConfig {
  framework: 'fastapi' | 'django' | 'express' | 'spring';
  frontend: 'none' | 'react' | 'nextjs' | 'vue' | 'angular';
  database: 'postgresql' | 'mysql' | 'mongodb';
  cicd: string[];
  multiTenant: boolean;
  autoApply: boolean;
  strictErrors: boolean;
}

export class SettingsEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private static _context: vscode.ExtensionContext | undefined;
  private static _currentPanel: vscode.WebviewPanel | undefined;

  static init(context: vscode.ExtensionContext): void {
    SettingsEditorProvider._context = context;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    SettingsEditorProvider.init(context);
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new SettingsEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  static get settingsUri(): vscode.Uri {
    // Use an untitled virtual document so VS Code opens this as an editor tab
    // and reliably routes it through the custom editor provider.
    return vscode.Uri.parse(SETTINGS_DOC_URI);
  }

  /** Show on first install — only if setup hasn't been completed */
  static async showIfFirstInstall(): Promise<void> {
    const ctx = SettingsEditorProvider._context;
    if (!ctx) return;
    const done = ctx.globalState.get<boolean>(SETUP_DONE_KEY, false);
    if (!done) {
      await SettingsEditorProvider.open();
    }
  }

  /** Reset setup state (for testing/re-run) */
  static async resetSetupState(): Promise<void> {
    const ctx = SettingsEditorProvider._context;
    if (!ctx) return;
    await ctx.globalState.update(SETUP_DONE_KEY, false);
    log('Setup state reset');
  }

  /** Open/focus the settings editor tab (singleton). */
  static async open(): Promise<void> {
    if (SettingsEditorProvider._currentPanel) {
      SettingsEditorProvider._currentPanel.reveal(vscode.ViewColumn.One, false);
      return;
    }

    try {
      // Ensure the virtual document exists before opening with the custom editor.
      await vscode.workspace.openTextDocument(SettingsEditorProvider.settingsUri);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        SettingsEditorProvider.settingsUri,
        VIEW_TYPE,
        { viewColumn: vscode.ViewColumn.One, preview: false }
      );

      // If the editor didn't resolve (e.g., provider not registered), fallback.
      // This avoids leaving users on a plain untitled text editor.
      setTimeout(() => {
        if (!SettingsEditorProvider._currentPanel) {
          log('Settings editor did not resolve; falling back to popup UI.');
          SettingsEditorProvider._openFallbackPanel();
        }
      }, 50);
    } catch (err) {
      log(`Settings editor open failed, falling back to popup: ${String(err)}`);
      SettingsEditorProvider._openFallbackPanel();
    }
  }

  private readonly _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<CopilotSkillsSettingsDocument> {
    return new CopilotSkillsSettingsDocument(uri);
  }

  async resolveCustomEditor(
    _document: CopilotSkillsSettingsDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    try {
      SettingsEditorProvider._currentPanel = webviewPanel;

      webviewPanel.title = 'Agent Slayer Settings';
      webviewPanel.iconPath = vscode.Uri.file(path.join(this._context.extensionPath, 'icon.png'));
      webviewPanel.webview.options = {
        enableScripts: true,
      };

      webviewPanel.webview.html = SettingsEditorProvider._getHtml(this._context);

      webviewPanel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case 'install':
              await SettingsEditorProvider._handleInstall(this._context, message.config, webviewPanel);
              break;
            case 'skip':
              webviewPanel.dispose();
              break;
          }
        },
        undefined,
        this._context.subscriptions
      );

      webviewPanel.onDidDispose(() => {
        if (SettingsEditorProvider._currentPanel === webviewPanel) {
          SettingsEditorProvider._currentPanel = undefined;
        }
      });

    } catch (err) {
      log(`Settings editor resolve failed, falling back to popup: ${err}`);
      SettingsEditorProvider._openFallbackPanel();
    }
  }

  /** Handle install message from webview */
  private static async _handleInstall(
    context: vscode.ExtensionContext,
    cfg: SetupConfig,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    try {
      log(`Setup: installing with config ${JSON.stringify(cfg)}`);

      // Map webview config to extension Config shape
      const config: Config = {
        frontendFramework: cfg.frontend,
        stack: SettingsEditorProvider._mapFramework(cfg.framework),
        database: cfg.database,
        multiTenant: cfg.multiTenant,
        autoInstallOnStartup: cfg.autoApply,
        orgIdField: 'org_id',
        testFramework: SettingsEditorProvider._defaultTestFramework(cfg.framework),
        cicd: cfg.cicd,
        strictErrorFormat: cfg.strictErrors,
      };

      // Apply global Copilot instructions
      await applyGlobalSettings(config);

      // Write config to VS Code global settings
      const globalCfg = vscode.workspace.getConfiguration();
      await globalCfg.update(
        'agentSlayer.frontendFramework',
        config.frontendFramework,
        vscode.ConfigurationTarget.Global
      );
      await globalCfg.update('agentSlayer.cicd', cfg.cicd, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.strictErrorFormat', cfg.strictErrors, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.stack', config.stack, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.database', config.database, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.multiTenant', config.multiTenant, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.autoInstallOnStartup', config.autoInstallOnStartup, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.orgIdField', config.orgIdField, vscode.ConfigurationTarget.Global);
      await globalCfg.update('agentSlayer.testFramework', config.testFramework, vscode.ConfigurationTarget.Global);

      // Install prompt files
      const result = await installPromptFiles(context.extensionPath);

      // Mark setup as done
      await context.globalState.update(SETUP_DONE_KEY, true);

      log(`Setup complete: ${result.installed.length} prompts installed`);

      // Notify webview — success
      panel.webview.postMessage({
        command: 'installDone',
        promptsInstalled: result.installed.length,
      });

      // Close panel after short delay
      setTimeout(() => panel.dispose(), 2800);

    } catch (err) {
      log(`Setup install error: ${err}`);
      panel.webview.postMessage({ command: 'installError', error: 'Installation failed. See Output → Agent Slayer.' });
      vscode.window.showErrorMessage('Agent Slayer setup failed. See Output → Agent Slayer.');
    }
  }

  /** Map webview framework value to Config stack */
  private static _mapFramework(fw: string): Config['stack'] {
    const map: Record<string, Config['stack']> = {
      fastapi: 'fastapi',
      django: 'django',
      express: 'nodejs',
      spring: 'nodejs', // override in instructionBuilder for java
    };
    return map[fw] ?? 'fastapi';
  }

  /** Sensible default test framework per stack */
  private static _defaultTestFramework(fw: string): Config['testFramework'] {
    if (fw === 'express') return 'jest';
    if (fw === 'spring') return 'jest'; // placeholder — Java uses JUnit
    return 'pytest';
  }

  /** Load HTML from disk */
  private static _getHtml(context: vscode.ExtensionContext): string {
    const htmlPath = path.join(context.extensionPath, 'src', 'webview', 'setup.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      return SettingsEditorProvider._fallbackHtml();
    }
  }

  /** Minimal fallback if HTML file missing */
  private static _fallbackHtml(): string {
    return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#cccccc;font-family:Segoe UI, sans-serif;padding:40px;">
      <h2>Agent Slayer</h2>
      <p>Setup UI not found. Run <b>Agent Slayer: Install Global Instructions</b> from the command palette.</p>
    </body></html>`;
  }

  /** Fallback to legacy popup panel when custom editor is unavailable. */
  private static _openFallbackPanel(): void {
    const ctx = SettingsEditorProvider._context;
    if (!ctx) return;

    try {
      if (SettingsEditorProvider._currentPanel) {
        SettingsEditorProvider._currentPanel.reveal(vscode.ViewColumn.One, false);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'copilotSkillsSetupFallback',
        'Agent Slayer — Setup',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
      );

      panel.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, 'icon.png'));
      panel.webview.html = SettingsEditorProvider._getHtml(ctx);

      panel.webview.onDidReceiveMessage(
        async (message) => {
          switch (message.command) {
            case 'install':
              await SettingsEditorProvider._handleInstall(ctx, message.config, panel);
              break;
            case 'skip':
              panel.dispose();
              break;
          }
        },
        undefined,
        ctx.subscriptions
      );

      panel.onDidDispose(() => {
        if (SettingsEditorProvider._currentPanel === panel) {
          SettingsEditorProvider._currentPanel = undefined;
        }
      });

      SettingsEditorProvider._currentPanel = panel;

    } catch (err) {
      log(`Fallback popup failed: ${err}`);
    }
  }
}
