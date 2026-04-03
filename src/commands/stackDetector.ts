import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { log } from '../utils/logger';

const DETECTION_STATE_KEY = 'agentSlayer.detectedStackByFolder';
const RECOMMENDED_PROMPTS_KEY = 'agentSlayer.recommendedPrompts';

interface DetectionSnapshot {
  stack: string[];
  detectedAt: string;
}

type DetectionState = Record<string, DetectionSnapshot>;

interface StackDetectionResult {
  workspaceName: string;
  workspacePath: string;
  stack: string[];
  recommendedPrompts: string[];
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export class StackDetector implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private activePanel: vscode.WebviewPanel | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static async initialize(
    context: vscode.ExtensionContext
  ): Promise<StackDetector> {
    const detector = new StackDetector(context);
    await detector.init();
    context.subscriptions.push(detector);
    return detector;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    if (this.activePanel) {
      this.activePanel.dispose();
      this.activePanel = undefined;
    }
  }

  private async init(): Promise<void> {
    const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(
      async (event) => {
        for (const folder of event.added) {
          await this.detectForFolder(folder);
        }
      }
    );

    this.disposables.push(workspaceListener);
    this.context.subscriptions.push(workspaceListener);

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      await this.detectForFolder(folder);
    }
  }

  private async detectForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      const state = this.getDetectionState();
      if (state[folder.uri.fsPath]) {
        return;
      }

      const result = await this.detectStack(folder);
      state[folder.uri.fsPath] = {
        stack: result.stack,
        detectedAt: new Date().toISOString(),
      };
      await this.context.workspaceState.update(DETECTION_STATE_KEY, state);

      if (!result.stack.length) {
        return;
      }

      await this.showNotificationPanel(result);
    } catch (error) {
      log('Stack detector failed for folder ' + folder.name + ': ' + String(error));
    }
  }

  private async detectStack(
    folder: vscode.WorkspaceFolder
  ): Promise<StackDetectionResult> {
    const workspacePath = folder.uri.fsPath;
    const stack = new Set<string>();

    const fileChecks = await Promise.all([
      this.fileExists(path.join(workspacePath, 'package.json')),
      this.fileExists(path.join(workspacePath, 'requirements.txt')),
      this.fileExists(path.join(workspacePath, 'Cargo.toml')),
      this.fileExists(path.join(workspacePath, 'go.mod')),
      this.fileExists(path.join(workspacePath, 'pom.xml')),
    ]);

    const [hasPackageJson, hasRequirements, hasCargo, hasGoMod, hasPom] = fileChecks;

    if (hasRequirements) {
      stack.add('Python');
    }

    if (hasCargo) {
      stack.add('Rust');
    }

    if (hasGoMod) {
      stack.add('Go');
    }

    if (hasPom) {
      stack.add('Java Maven');
    }

    if (hasPackageJson) {
      stack.add('Node');
      await this.detectFromPackageJson(workspacePath, stack);
    }

    const stackList = Array.from(stack);
    const recommendedPrompts = await this.getRecommendedPrompts(stackList);

    return {
      workspaceName: folder.name,
      workspacePath,
      stack: stackList,
      recommendedPrompts,
    };
  }

  private async detectFromPackageJson(
    workspacePath: string,
    stack: Set<string>
  ): Promise<void> {
    const packageJsonPath = path.join(workspacePath, 'package.json');

    try {
      const content = await fs.readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(content) as PackageJsonShape;
      const deps = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {}),
      };

      if (this.hasDep(deps, 'next')) {
        stack.add('Next.js');
      }

      if (this.hasDep(deps, 'react') && this.hasDep(deps, 'vite')) {
        stack.add('React + Vite');
      }

      if (this.hasDep(deps, 'express') || this.hasDep(deps, 'fastify')) {
        stack.add('Node API');
      }

      if (this.hasDep(deps, 'prisma')) {
        stack.add('Prisma');
      }

      if (this.hasDep(deps, 'drizzle') || this.hasDep(deps, 'drizzle-orm')) {
        stack.add('Drizzle ORM');
      }

      if (this.hasDep(deps, 'tailwindcss')) {
        stack.add('Tailwind');
      }
    } catch (error) {
      log('Failed to parse package.json for stack detection: ' + String(error));
    }
  }

  private hasDep(deps: Record<string, string>, target: string): boolean {
    return Object.prototype.hasOwnProperty.call(deps, target);
  }

  private async getRecommendedPrompts(stack: string[]): Promise<string[]> {
    const suggestions: string[] = [];

    if (stack.includes('Next.js') || stack.includes('React + Vite')) {
      suggestions.push('new-feature.prompt.md', 'polish.prompt.md', 'write-tests.prompt.md');
    }

    if (stack.includes('Node API')) {
      suggestions.push('new-endpoint.prompt.md', 'security-review.prompt.md');
    }

    if (stack.includes('Prisma') || stack.includes('Drizzle ORM')) {
      suggestions.push('db-query.prompt.md', 'create-migration.prompt.md');
    }

    if (stack.includes('Tailwind')) {
      suggestions.push('polish.prompt.md');
    }

    if (
      stack.includes('Python') ||
      stack.includes('Rust') ||
      stack.includes('Go') ||
      stack.includes('Java Maven')
    ) {
      suggestions.push('debug-and-fix.prompt.md', 'code-review.prompt.md');
    }

    suggestions.push('debug-and-fix.prompt.md');

    const unique = Array.from(new Set(suggestions));
    const available = await this.getAvailablePromptFiles();
    return unique.filter((prompt) => available.has(prompt));
  }

  private async getAvailablePromptFiles(): Promise<Set<string>> {
    const promptsDir = path.join(this.context.extensionPath, 'prompts');

    try {
      const files = await fs.readdir(promptsDir);
      return new Set(files.filter((file) => file.endsWith('.prompt.md')));
    } catch {
      return new Set<string>();
    }
  }

  private async showNotificationPanel(result: StackDetectionResult): Promise<void> {
    if (this.activePanel) {
      this.activePanel.dispose();
      this.activePanel = undefined;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentSlayer.stackNotification',
      'Agent Slayer Stack Detection',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview')],
      }
    );

    this.activePanel = panel;
    panel.webview.html = await this.getNotificationHtml(panel.webview, result);

    const autoDismissTimer = setTimeout(() => {
      if (this.activePanel === panel) {
        panel.dispose();
      }
    }, 8000);

    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const command = this.extractCommand(message);

      if (command === 'dismiss') {
        panel.dispose();
        return;
      }

      if (command === 'activateRecommended') {
        await this.activateRecommendedPrompts(result.recommendedPrompts);
        panel.dispose();
      }
    });

    const disposeDisposable = panel.onDidDispose(() => {
      clearTimeout(autoDismissTimer);
      messageDisposable.dispose();

      if (this.activePanel === panel) {
        this.activePanel = undefined;
      }
    });

    this.disposables.push(messageDisposable, disposeDisposable);
    this.context.subscriptions.push(messageDisposable, disposeDisposable);
  }

  private extractCommand(message: unknown): string {
    if (!message || typeof message !== 'object') {
      return '';
    }

    const payload = message as Record<string, unknown>;
    return typeof payload.command === 'string' ? payload.command : '';
  }

  private async activateRecommendedPrompts(prompts: string[]): Promise<void> {
    if (!prompts.length) {
      vscode.window.showInformationMessage('Agent Slayer: No matching prompts were found.');
      return;
    }

    try {
      await this.context.workspaceState.update(RECOMMENDED_PROMPTS_KEY, prompts);
      await vscode.commands.executeCommand('agentSlayer.setActivePrompt', {
        promptFile: prompts[0],
        notify: false,
      });

      vscode.window.showInformationMessage(
        'Agent Slayer: Activated recommended prompts for this stack.'
      );
    } catch (error) {
      log('Failed activating recommended prompts: ' + String(error));
      vscode.window.showErrorMessage('Agent Slayer: Could not activate recommended prompts.');
    }
  }

  private async getNotificationHtml(
    webview: vscode.Webview,
    result: StackDetectionResult
  ): Promise<string> {
    const templatePath = path.join(
      this.context.extensionPath,
      'src',
      'webview',
      'stackNotification.html'
    );

    const nonce = this.getNonce();
    const iconUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'icon.png'))
      .toString();
    const stackTags = result.stack
      .map((item) => '<span class="tag">' + this.escapeHtml(item) + '</span>')
      .join('');
    const promptList = result.recommendedPrompts
      .map((prompt) => '<li>' + this.escapeHtml(this.promptLabel(prompt)) + '</li>')
      .join('');

    const fallback = this.fallbackHtml(webview, nonce, result, stackTags, promptList);

    try {
      const template = await fs.readFile(templatePath, 'utf8');
      return template
        .replace(/__CSP_SOURCE__/g, webview.cspSource)
        .replace(/__NONCE__/g, nonce)
        .replace(/__WORKSPACE_NAME__/g, this.escapeHtml(result.workspaceName))
        .replace(/__ICON_URI__/g, iconUri)
        .replace(/__STACK_TAGS__/g, stackTags)
        .replace(/__PROMPT_LIST__/g, promptList)
        .replace(/__STACK_COUNT__/g, String(result.stack.length));
    } catch (error) {
      log('Failed to load stack notification HTML template: ' + String(error));
      return fallback;
    }
  }

  private fallbackHtml(
    webview: vscode.Webview,
    nonce: string,
    result: StackDetectionResult,
    stackTags: string,
    promptList: string
  ): string {
    return '<!DOCTYPE html><html><head>' +
      '<meta charset="UTF-8" />' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-' + nonce + '\'; script-src \'nonce-' + nonce + '\';" />' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
      '<style nonce="' + nonce + '">body{background:#0a0a0f;color:#f8fafc;font-family:system-ui,sans-serif;padding:16px;}button{margin-right:8px;}</style>' +
      '</head><body>' +
      '<h3>Agent Slayer Stack Detection</h3>' +
      '<p>Workspace: ' + this.escapeHtml(result.workspaceName) + '</p>' +
      '<div>' + stackTags + '</div>' +
      '<ul>' + promptList + '</ul>' +
      '<button id="activate">Activate Recommended Prompts</button><button id="dismiss">Dismiss</button>' +
      '<script nonce="' + nonce + '">const vscode=acquireVsCodeApi();document.getElementById("activate").addEventListener("click",()=>vscode.postMessage({command:"activateRecommended"}));document.getElementById("dismiss").addEventListener("click",()=>vscode.postMessage({command:"dismiss"}));setTimeout(()=>vscode.postMessage({command:"dismiss"}),8000);</script>' +
      '</body></html>';
  }

  private getDetectionState(): DetectionState {
    return this.context.workspaceState.get<DetectionState>(DETECTION_STATE_KEY, {});
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private promptLabel(promptFile: string): string {
    return promptFile
      .replace(/\.prompt\.md$/i, '')
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
  }
}