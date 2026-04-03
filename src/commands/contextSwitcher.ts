import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';

export const ACTIVE_PROMPT_KEY = 'agentSlayer.activePromptFile';

const DEFAULT_PROMPT = 'debug-and-fix.prompt.md';
const NEW_FEATURE_PROMPT = 'new-feature.prompt.md';
const WRITE_TESTS_PROMPT = 'write-tests.prompt.md';
const CREATE_MIGRATION_PROMPT = 'create-migration.prompt.md';
const DB_QUERY_PROMPT = 'db-query.prompt.md';
const SECURITY_PROMPT = 'security-review.prompt.md';

const PROMPT_LABELS: Record<string, string> = {
  [DEFAULT_PROMPT]: 'Debug & Fix',
  [NEW_FEATURE_PROMPT]: 'New Feature',
  [WRITE_TESTS_PROMPT]: 'Write Tests',
  [CREATE_MIGRATION_PROMPT]: 'Create Migration',
  [DB_QUERY_PROMPT]: 'DB Query',
  [SECURITY_PROMPT]: 'Security Review',
};

interface SetPromptArgs {
  promptFile: string;
  notify?: boolean;
}

export class AgentContextSwitcher implements vscode.Disposable {
  private readonly statusItem: vscode.StatusBarItem;
  private readonly availablePrompts = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      120
    );
  }

  public static async initialize(
    context: vscode.ExtensionContext
  ): Promise<AgentContextSwitcher> {
    const switcher = new AgentContextSwitcher(context);
    await switcher.init();
    context.subscriptions.push(switcher);
    return switcher;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.statusItem.dispose();
  }

  private async init(): Promise<void> {
    await this.loadAvailablePrompts();
    await this.ensureActivePrompt();
    this.configureStatusBar();
    this.refreshStatusBarText();

    const setPromptCmd = vscode.commands.registerCommand(
      'agentSlayer.setActivePrompt',
      async (args: SetPromptArgs | string) => {
        const payload = this.normalizeSetPromptArgs(args);
        if (!payload) {
          return;
        }

        await this.setActivePrompt(payload.promptFile, {
          notify: payload.notify ?? false,
        });
      }
    );

    const openSidebarCmd = vscode.commands.registerCommand(
      'agentSlayer.openSidebar',
      async () => {
        await this.openSidebar();
      }
    );

    const editorChange = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      await this.autoSwitchForEditor(editor);
    });

    this.disposables.push(setPromptCmd, openSidebarCmd, editorChange);
    this.context.subscriptions.push(setPromptCmd, openSidebarCmd, editorChange, this.statusItem);

    await this.autoSwitchForEditor(vscode.window.activeTextEditor);
  }

  private normalizeSetPromptArgs(
    args: SetPromptArgs | string
  ): SetPromptArgs | null {
    if (typeof args === 'string') {
      return { promptFile: args };
    }

    if (!args || typeof args !== 'object' || typeof args.promptFile !== 'string') {
      return null;
    }

    return args;
  }

  private async loadAvailablePrompts(): Promise<void> {
    const promptsDir = path.join(this.context.extensionPath, 'prompts');

    try {
      const entries = await fs.readdir(promptsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.prompt.md')) {
          this.availablePrompts.add(entry.name);
        }
      }
    } catch {
      this.availablePrompts.clear();
    }
  }

  private async ensureActivePrompt(): Promise<void> {
    const current = this.context.workspaceState.get<string | null>(ACTIVE_PROMPT_KEY, null);
    const resolved = this.resolvePrompt(current ?? DEFAULT_PROMPT);
    await this.context.workspaceState.update(ACTIVE_PROMPT_KEY, resolved);
  }

  private configureStatusBar(): void {
    this.statusItem.command = 'agentSlayer.openSidebar';
    this.statusItem.tooltip = 'Agent Slayer - Click to open sidebar';
    this.statusItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
    this.statusItem.show();
  }

  private refreshStatusBarText(): void {
    const active = this.context.workspaceState.get<string>(ACTIVE_PROMPT_KEY, DEFAULT_PROMPT);
    this.statusItem.text = '$(zap) Agent: ' + this.promptLabel(active);
  }

  private async autoSwitchForEditor(
    editor: vscode.TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      return;
    }

    const selectedPrompt = this.selectPromptFromEditor(editor.document);
    await this.setActivePrompt(selectedPrompt, { notify: true });
  }

  private selectPromptFromEditor(document: vscode.TextDocument): string {
    const fullPath = document.uri.fsPath.toLowerCase();
    const fileName = path.basename(fullPath);

    if (fileName.endsWith('.md') && fullPath.includes('security')) {
      return this.resolvePrompt(SECURITY_PROMPT);
    }

    if (
      fileName.endsWith('.test.ts') ||
      fileName.endsWith('.spec.ts') ||
      fileName.endsWith('.test.js')
    ) {
      return this.resolvePrompt(WRITE_TESTS_PROMPT);
    }

    if (
      fileName.endsWith('.tsx') ||
      fileName.endsWith('.jsx') ||
      fileName.endsWith('.vue')
    ) {
      return this.resolvePrompt(NEW_FEATURE_PROMPT);
    }

    if (fullPath.includes('migration')) {
      return this.resolvePrompt(CREATE_MIGRATION_PROMPT);
    }

    if (fileName.endsWith('.sql')) {
      return this.resolvePrompt(DB_QUERY_PROMPT);
    }

    if (
      fullPath.includes('route') ||
      fullPath.includes('controller') ||
      fullPath.includes('api')
    ) {
      return this.resolvePrompt(NEW_FEATURE_PROMPT);
    }

    return this.resolvePrompt(DEFAULT_PROMPT);
  }

  private resolvePrompt(candidate: string): string {
    if (this.availablePrompts.has(candidate)) {
      return candidate;
    }

    if (this.availablePrompts.has(DEFAULT_PROMPT)) {
      return DEFAULT_PROMPT;
    }

    const firstPrompt = Array.from(this.availablePrompts).sort((a, b) =>
      a.localeCompare(b)
    )[0];
    return firstPrompt ?? candidate;
  }

  private async setActivePrompt(
    promptFile: string,
    options: { notify: boolean }
  ): Promise<void> {
    const resolvedPrompt = this.resolvePrompt(promptFile);
    const previous = this.context.workspaceState.get<string>(
      ACTIVE_PROMPT_KEY,
      DEFAULT_PROMPT
    );

    if (previous === resolvedPrompt) {
      return;
    }

    await this.context.workspaceState.update(ACTIVE_PROMPT_KEY, resolvedPrompt);
    this.refreshStatusBarText();

    if (options.notify) {
      vscode.window.showInformationMessage(
        'Agent Slayer: Switched to ' + this.promptLabel(resolvedPrompt)
      );
    }
  }

  private promptLabel(promptFile: string): string {
    const mapped = PROMPT_LABELS[promptFile];
    if (mapped) {
      return mapped;
    }

    return promptFile
      .replace(/\.prompt\.md$/i, '')
      .split(/[-_]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }

  private async openSidebar(): Promise<void> {
    try {
      await vscode.commands.executeCommand('agentSlayer.sidebar.focus');
      return;
    } catch {
      // Ignore and continue to fallback.
    }

    try {
      await vscode.commands.executeCommand('workbench.view.extension');
      await vscode.commands.executeCommand('agentSlayer.sidebar.focus');
      return;
    } catch {
      await vscode.commands.executeCommand('copilotSkills.openSetup');
    }
  }
}