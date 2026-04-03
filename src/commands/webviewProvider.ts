import * as path from 'path';
import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as vscode from 'vscode';
import { ACTIVE_PROMPT_KEY } from './contextSwitcher';
import { log } from '../utils/logger';

interface PromptCard {
  fileName: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  content: string;
  icon: string;
}

interface SidebarState {
  version: string;
  prompts: PromptCard[];
  activePromptFile: string | null;
  activePrompt: PromptCard | null;
}

interface PromptEditorPayload {
  name: string;
  category: string;
  description: string;
  content: string;
  tags: string;
}

type IncomingMessage =
  | { command: 'activatePrompt'; fileName: string }
  | { command: 'sync' }
  | { command: 'openMarketplace' }
  | { command: 'createPrompt'; prompt: PromptEditorPayload }
  | { command: 'updatePrompt'; fileName: string; prompt: PromptEditorPayload }
  | { command: 'deletePrompt'; fileName: string }
  | { command: 'duplicatePrompt'; fileName: string };

interface FrontmatterData {
  name: string;
  description: string;
  category: string;
  tags: string[];
}

const CATEGORIES = [
  'Frontend',
  'Backend',
  'DevOps',
  'Security',
  'Testing',
  'Architecture',
  'General',
];

export class AgentSlayerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentSlayer.sidebar';

  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AgentSlayerSidebarProvider(context);
    return vscode.window.registerWebviewViewProvider(
      AgentSlayerSidebarProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    );
  }

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    const state = await this.buildState();
    webviewView.webview.html = this.getHtml(webviewView.webview, state);

    webviewView.webview.onDidReceiveMessage(
      async (rawMessage: unknown) => {
        const message = this.parseMessage(rawMessage);
        if (!message) {
          return;
        }

        await this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (message.command === 'activatePrompt') {
      await vscode.commands.executeCommand('agentSlayer.setActivePrompt', {
        promptFile: message.fileName,
        notify: false,
      });
      await this.postState();
      return;
    }

    if (message.command === 'sync') {
      await vscode.commands.executeCommand('copilotSkills.installPrompts');
      await this.postState();
      return;
    }

    if (message.command === 'openMarketplace') {
      await vscode.commands.executeCommand('agentSlayer.openMarketplace');
      return;
    }

    if (message.command === 'createPrompt') {
      await this.createPrompt(message.prompt);
      return;
    }

    if (message.command === 'updatePrompt') {
      await this.updatePrompt(message.fileName, message.prompt);
      return;
    }

    if (message.command === 'deletePrompt') {
      await this.deletePrompt(message.fileName);
      return;
    }

    if (message.command === 'duplicatePrompt') {
      await this.duplicatePrompt(message.fileName);
      return;
    }

    return;
  }

  private parseMessage(rawMessage: unknown): IncomingMessage | null {
    if (!rawMessage || typeof rawMessage !== 'object') {
      return null;
    }

    const msg = rawMessage as Record<string, unknown>;
    if (msg.command === 'sync' || msg.command === 'openMarketplace') {
      return msg as IncomingMessage;
    }

    if (msg.command === 'activatePrompt' && typeof msg.fileName === 'string') {
      return { command: 'activatePrompt', fileName: msg.fileName };
    }

    if (msg.command === 'createPrompt' && this.isPromptPayload(msg.prompt)) {
      return { command: 'createPrompt', prompt: msg.prompt };
    }

    if (
      msg.command === 'updatePrompt' &&
      typeof msg.fileName === 'string' &&
      this.isPromptPayload(msg.prompt)
    ) {
      return {
        command: 'updatePrompt',
        fileName: msg.fileName,
        prompt: msg.prompt,
      };
    }

    if (msg.command === 'deletePrompt' && typeof msg.fileName === 'string') {
      return { command: 'deletePrompt', fileName: msg.fileName };
    }

    if (msg.command === 'duplicatePrompt' && typeof msg.fileName === 'string') {
      return { command: 'duplicatePrompt', fileName: msg.fileName };
    }

    return null;
  }

  private isPromptPayload(payload: unknown): payload is PromptEditorPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const row = payload as Record<string, unknown>;
    return (
      typeof row.name === 'string' &&
      typeof row.category === 'string' &&
      typeof row.description === 'string' &&
      typeof row.content === 'string' &&
      typeof row.tags === 'string'
    );
  }

  private async createPrompt(payload: PromptEditorPayload): Promise<void> {
    const promptsDir = this.getWritablePromptsDirectory();
    if (!promptsDir) {
      this.postToast('Open a workspace folder to create prompts.', true);
      return;
    }

    const sanitized = this.sanitizePayload(payload);
    if (!sanitized.name || !sanitized.content) {
      this.postToast('Name and content are required.', true);
      return;
    }

    const baseSlug = this.slugify(sanitized.name);
    const fileName = await this.uniquePromptFileName(baseSlug, promptsDir);
    const content = this.toPromptFileContent(sanitized);

    try {
      await fs.mkdir(promptsDir, { recursive: true });
      await fs.writeFile(path.join(promptsDir, fileName), content, 'utf8');
      await this.postState(fileName);
      this.postToast('Prompt created \u2713');
    } catch (error) {
      log('Failed to create prompt: ' + String(error));
      this.postToast('Failed to create prompt.', true);
    }
  }

  private async updatePrompt(
    originalFileName: string,
    payload: PromptEditorPayload
  ): Promise<void> {
    const promptsDir = this.getWritablePromptsDirectory();
    if (!promptsDir) {
      this.postToast('Open a workspace folder to edit prompts.', true);
      return;
    }

    const sanitized = this.sanitizePayload(payload);
    if (!sanitized.name || !sanitized.content) {
      this.postToast('Name and content are required.', true);
      return;
    }

    const originalPath = path.join(promptsDir, originalFileName);
    const nextFileName = this.slugify(sanitized.name) + '.prompt.md';
    const nextPath = path.join(promptsDir, nextFileName);

    try {
      const originalExists = await this.fileExists(originalPath);
      if (!originalExists) {
        this.postToast('Original prompt file was not found.', true);
        return;
      }

      if (originalFileName !== nextFileName) {
        const nextExists = await this.fileExists(nextPath);
        if (nextExists) {
          this.postToast('A prompt with that name already exists.', true);
          return;
        }
      }

      const fileContent = this.toPromptFileContent(sanitized);
      await fs.writeFile(nextPath, fileContent, 'utf8');
      if (originalFileName !== nextFileName) {
        await fs.unlink(originalPath);
      }

      await this.postState(nextFileName);
      this.postToast('Prompt updated \u2713');
    } catch (error) {
      log('Failed to update prompt: ' + String(error));
      this.postToast('Failed to update prompt.', true);
    }
  }

  private async deletePrompt(fileName: string): Promise<void> {
    const promptsDir = this.getWritablePromptsDirectory();
    if (!promptsDir) {
      this.postToast('Open a workspace folder to delete prompts.', true);
      return;
    }

    try {
      await fs.unlink(path.join(promptsDir, fileName));
      await this.postState();
      this.postToast('Prompt deleted \u2713');
    } catch (error) {
      log('Failed to delete prompt: ' + String(error));
      this.postToast('Failed to delete prompt.', true);
    }
  }

  private async duplicatePrompt(fileName: string): Promise<void> {
    const prompts = await this.loadPrompts();
    const source = prompts.find((item) => item.fileName === fileName);
    if (!source) {
      this.postToast('Prompt not found for duplication.', true);
      return;
    }

    const promptsDir = this.getWritablePromptsDirectory();
    if (!promptsDir) {
      this.postToast('Open a workspace folder to duplicate prompts.', true);
      return;
    }

    const duplicateName = source.name + ' (copy)';
    const duplicatePayload: PromptEditorPayload = {
      name: duplicateName,
      category: source.category,
      description: source.description,
      content: source.content,
      tags: source.tags.join(', '),
    };

    const sanitized = this.sanitizePayload(duplicatePayload);
    const baseSlug = this.slugify(sanitized.name);
    const fileNameOut = await this.uniquePromptFileName(baseSlug, promptsDir);

    try {
      await fs.writeFile(
        path.join(promptsDir, fileNameOut),
        this.toPromptFileContent(sanitized),
        'utf8'
      );
      await this.postState(fileNameOut);
      this.postToast('Prompt duplicated \u2713');
    } catch (error) {
      log('Failed to duplicate prompt: ' + String(error));
      this.postToast('Failed to duplicate prompt.', true);
    }
  }

  private sanitizePayload(payload: PromptEditorPayload): PromptEditorPayload {
    const category = CATEGORIES.includes(payload.category)
      ? payload.category
      : 'General';

    return {
      name: payload.name.trim().replace(/\s+/g, ' '),
      category,
      description: payload.description.trim().replace(/\s+/g, ' '),
      content: payload.content.trim(),
      tags: payload.tags.trim(),
    };
  }

  private toPromptFileContent(payload: PromptEditorPayload): string {
    const tags = this.normalizeTags(payload.tags).join(', ');
    return [
      '---',
      'name: ' + payload.name,
      'description: ' + payload.description,
      'category: ' + payload.category,
      'tags: ' + tags,
      '---',
      payload.content,
      '',
    ].join('\n');
  }

  private normalizeTags(raw: string): string[] {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug || 'prompt';
  }

  private async uniquePromptFileName(baseSlug: string, promptsDir: string): Promise<string> {
    let index = 1;
    while (true) {
      const suffix = index === 1 ? '' : '-' + String(index);
      const candidate = baseSlug + suffix + '.prompt.md';
      const exists = await this.fileExists(path.join(promptsDir, candidate));
      if (!exists) {
        return candidate;
      }

      index += 1;
    }
  }

  private async postState(pulseFile?: string): Promise<void> {
    if (!this.view) {
      return;
    }

    const state = await this.buildState();
    await this.view.webview.postMessage({
      command: 'state',
      state,
      pulseFile: pulseFile ?? '',
    });
  }

  private postToast(message: string, isError = false): void {
    if (!this.view) {
      return;
    }

    void this.view.webview.postMessage({
      command: 'toast',
      message,
      isError,
    });
  }

  private async buildState(): Promise<SidebarState> {
    const prompts = await this.loadPrompts();
    const requested = this.context.workspaceState.get<string | null>(
      ACTIVE_PROMPT_KEY,
      null
    );
    const activePromptFile = this.resolveActivePromptFile(prompts, requested);

    if (requested !== activePromptFile) {
      await this.context.workspaceState.update(ACTIVE_PROMPT_KEY, activePromptFile);
    }

    const activePrompt =
      prompts.find((prompt) => prompt.fileName === activePromptFile) ?? null;

    return {
      version: this.getExtensionVersion(),
      prompts,
      activePromptFile,
      activePrompt,
    };
  }

  private resolveActivePromptFile(
    prompts: PromptCard[],
    requested: string | null
  ): string | null {
    if (!prompts.length) {
      return null;
    }

    const requestedExists = prompts.some((prompt) => prompt.fileName === requested);
    return requestedExists && requested ? requested : prompts[0].fileName;
  }

  private getExtensionVersion(): string {
    const pkg = this.context.extension.packageJSON as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'dev';
  }

  private getReadablePromptsDirectory(): string {
    const workspaceDir = this.getWorkspacePromptsDirectory();
    return workspaceDir ?? path.join(this.context.extensionPath, 'prompts');
  }

  private getWritablePromptsDirectory(): string | null {
    return this.getWorkspacePromptsDirectory();
  }

  private getWorkspacePromptsDirectory(): string | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return null;
    }

    return path.join(folder.uri.fsPath, 'prompts');
  }

  private async loadPrompts(): Promise<PromptCard[]> {
    const promptsDirectory = this.getReadablePromptsDirectory();
    let files: nodeFs.Dirent[] = [];

    try {
      files = await fs.readdir(promptsDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const promptFiles = files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.prompt.md'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const prompts = await Promise.all(
      promptFiles.map((fileName) => this.loadSinglePrompt(promptsDirectory, fileName))
    );

    return prompts;
  }

  private async loadSinglePrompt(
    promptsDirectory: string,
    fileName: string
  ): Promise<PromptCard> {
    const filePath = path.join(promptsDirectory, fileName);
    const content = await this.readFileSafe(filePath);
    const parsed = this.parsePromptFile(content, fileName);

    return {
      fileName,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      category: parsed.frontmatter.category,
      tags: parsed.frontmatter.tags,
      content: parsed.body,
      icon: this.pickPromptIcon(fileName, parsed.frontmatter.category),
    };
  }

  private parsePromptFile(
    content: string,
    fileName: string
  ): { frontmatter: FrontmatterData; body: string } {
    const fallbackName = this.toPromptDisplayName(fileName);
    const fallbackDescription = 'No description available for this prompt.';

    const defaultFrontmatter: FrontmatterData = {
      name: fallbackName,
      description: fallbackDescription,
      category: 'General',
      tags: [],
    };

    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) {
      const body = content.trim();
      return {
        frontmatter: {
          ...defaultFrontmatter,
          description: this.extractPromptDescription(content),
        },
        body,
      };
    }

    const block = match[1] || '';
    const body = content.slice(match[0].length).trim();
    const parsed = { ...defaultFrontmatter };

    const lines = block.split(/\r?\n/);
    let readingTagsList = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (readingTagsList) {
        if (line.startsWith('- ')) {
          parsed.tags.push(line.slice(2).trim());
          continue;
        }

        readingTagsList = false;
      }

      const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!kv) {
        continue;
      }

      const key = kv[1].toLowerCase();
      const value = kv[2].trim();

      if (key === 'name') {
        parsed.name = this.stripQuotes(value) || parsed.name;
        continue;
      }

      if (key === 'description') {
        parsed.description =
          this.toShortDescription(this.stripQuotes(value)) || parsed.description;
        continue;
      }

      if (key === 'category') {
        const normalized = this.stripQuotes(value);
        parsed.category = CATEGORIES.includes(normalized) ? normalized : 'General';
        continue;
      }

      if (key === 'tags') {
        if (!value) {
          parsed.tags = [];
          readingTagsList = true;
          continue;
        }

        if (value.startsWith('[') && value.endsWith(']')) {
          parsed.tags = value
            .slice(1, -1)
            .split(',')
            .map((item) => this.stripQuotes(item.trim()))
            .filter(Boolean);
        } else {
          parsed.tags = value
            .split(',')
            .map((item) => this.stripQuotes(item.trim()))
            .filter(Boolean);
        }
      }
    }

    if (!parsed.description || parsed.description === fallbackDescription) {
      parsed.description = this.extractPromptDescription(content);
    }

    return {
      frontmatter: parsed,
      body,
    };
  }

  private stripQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/g, '').trim();
  }

  private async readFileSafe(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private toPromptDisplayName(fileName: string): string {
    const baseName = fileName.replace(/\.prompt\.md$/i, '');
    return baseName
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private extractPromptDescription(content: string): string {
    const frontMatter = content.match(/^---\s*[\s\S]*?\s---/);
    const frontMatterBlock = frontMatter ? frontMatter[0] : '';
    const described = frontMatterBlock.match(
      /^description:\s*["']([^"']+)["']\s*$/im
    );

    if (described?.[1]) {
      return this.toShortDescription(described[1]);
    }

    const body = frontMatter ? content.slice(frontMatter[0].length) : content;
    const firstUsefulLine = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 10 &&
          !line.startsWith('#') &&
          !line.startsWith('```') &&
          !line.startsWith('---') &&
          !line.startsWith('-')
      );

    return this.toShortDescription(
      firstUsefulLine ?? 'No description available for this prompt.'
    );
  }

  private toShortDescription(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 110) {
      return normalized;
    }

    return normalized.slice(0, 107).trimEnd() + '...';
  }

  private pickPromptIcon(fileName: string, category: string): string {
    const lower = fileName.toLowerCase();
    const cat = category.toLowerCase();

    if (lower.includes('security') || cat === 'security') return 'shield';
    if (lower.includes('test') || cat === 'testing') return 'beaker';
    if (lower.includes('debug') || lower.includes('fix')) return 'bug';
    if (lower.includes('query') || lower.includes('db')) return 'database';
    if (lower.includes('migration') || cat === 'backend') return 'arrows';
    if (lower.includes('endpoint') || lower.includes('route')) return 'api';
    if (lower.includes('feature') || cat === 'frontend') return 'spark';
    return 'file';
  }

  private getHtml(webview: vscode.Webview, state: SidebarState): string {
    const nonce = this.getNonce();
    const initialState = JSON.stringify(state).replace(/</g, '\\u003c');
    const iconUri = webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'icon.png'))
      .toString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Slayer</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background);
      --surface: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      --text: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-panel-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)));
      --hover: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1));
      --active-bg: var(--vscode-list-activeSelectionBackground, var(--surface));
      --active-fg: var(--vscode-list-activeSelectionForeground, var(--text));
      --active-border: var(--vscode-focusBorder);
      --active-accent: var(--vscode-textLink-foreground);
      --danger: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, var(--text)));
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: hidden;
    }

    .layout {
      height: 100%;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 0;
      padding: 0 8px 8px;
      position: relative;
    }

    .header {
      padding: 12px 12px 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .logo {
      width: 28px;
      height: 28px;
      border-radius: 0;
      border: 0;
      background: transparent;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .badge {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--muted);
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1;
    }

    .create-btn {
      min-width: 54px;
      height: 24px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 0 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 140ms ease, border-color 140ms ease;
    }

    .create-btn:hover {
      background: var(--vscode-button-hoverBackground);
      border-color: var(--active-border);
    }

    .list-wrap {
      overflow: hidden;
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 8px;
    }

    .list-separator {
      height: 1px;
      background: var(--line);
      width: 100%;
    }

    .list {
      overflow: auto;
      min-height: 0;
      display: grid;
      gap: 2px;
      padding: 0;
      padding-bottom: 96px;
    }

    .list::-webkit-scrollbar {
      width: 4px;
    }

    .list::-webkit-scrollbar-track {
      background: var(--surface);
    }

    .list::-webkit-scrollbar-thumb {
      background: var(--line);
      border-radius: 999px;
    }

    .prompt-card {
      position: relative;
      height: 64px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      transition: background 160ms ease, border-color 160ms ease;
      overflow: hidden;
    }

    .prompt-card:hover {
      background: var(--hover);
      border-color: var(--line);
    }

    .prompt-card.active {
      background: var(--active-bg);
      border-color: var(--active-border);
    }

    .prompt-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      border-radius: 0;
      background: var(--active-accent);
    }

    .prompt-card.pulse { }

    .prompt-enter {
      opacity: 0;
      transform: translateY(8px);
      animation: cardEnter 240ms ease forwards;
    }

    @keyframes cardEnter {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .prompt-head {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1;
      padding-right: 8px;
    }

    .prompt-name {
      font-size: 14px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      width: 100%;
    }

    .prompt-description {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.15;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .prompt-tags {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 1px;
      display: none;
    }

    .prompt-card.active .prompt-tags {
      display: inline-flex;
    }

    .tag-pill {
      font-size: 11px;
      font-size: 10px;
      line-height: 1;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--active-accent);
      padding: 2px 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .action-btn,
    .modal-btn,
    .ghost-btn,
    .confirm-btn {
      position: relative;
      overflow: hidden;
      border-radius: 9px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: border-color 200ms ease, background 200ms ease, transform 200ms ease;
      font-weight: 600;
    }

    .action-btn:hover,
    .modal-btn:hover,
    .ghost-btn:hover,
    .confirm-btn:hover {
      transform: translateY(-1px);
      border-color: var(--active-border);
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .context-menu {
      position: fixed;
      display: none;
      min-width: 104px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: var(--surface);
      padding: 4px;
      z-index: 20;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    }

    .context-menu.open {
      display: grid;
      gap: 3px;
    }

    .context-item {
      border: 0;
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 5px 7px;
      font-size: 12px;
      font-weight: 500;
      width: 100%;
      border-radius: 4px;
      cursor: pointer;
    }

    .context-item:hover {
      background: var(--hover);
    }

    .bottom {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 8px 0 8px;
    }

    .empty {
      border: 1px dashed var(--line);
      border-radius: 10px;
      padding: 14px;
      font-size: 12px;
      color: var(--muted);
      text-align: center;
      background: var(--surface);
    }

    #sync-btn,
    #marketplace-btn {
      height: 32px;
      border-radius: 6px;
      font-size: 12px;
      padding: 0 10px;
      width: 100%;
    }

    #sync-btn {
      background: transparent;
      border: 1px solid var(--line);
      color: var(--muted);
    }

    #marketplace-btn {
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
    }

    .toast {
      position: absolute;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%) translateY(12px);
      background: var(--vscode-notifications-background, var(--surface));
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      color: var(--vscode-notifications-foreground, var(--text));
      opacity: 0;
      pointer-events: none;
      transition: opacity 170ms ease, transform 170ms ease;
      z-index: 7;
      max-width: calc(100% - 28px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .toast.error {
      border-color: var(--vscode-inputValidation-errorBorder, var(--line));
      color: var(--vscode-inputValidation-errorForeground, var(--danger));
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      display: grid;
      place-items: end center;
      padding: 12px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
      z-index: 9;
    }

    .modal-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .modal-card {
      width: min(560px, 100%);
      max-height: calc(100vh - 24px);
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--surface);
      transform: translateY(100px);
      opacity: 0;
      transition: transform 300ms ease, opacity 300ms ease;
      display: grid;
      grid-template-rows: auto 1fr auto;
      overflow: hidden;
    }

    .modal-backdrop.open .modal-card {
      transform: translateY(0);
      opacity: 1;
    }

    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      gap: 10px;
    }

    .modal-title {
      font-size: 14px;
      font-weight: 700;
    }

    .modal-body {
      padding: 12px;
      overflow: auto;
      display: grid;
      gap: 10px;
    }

    .field {
      display: grid;
      gap: 6px;
    }

    .label {
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .input,
    .select,
    .textarea {
      border: 1px solid var(--vscode-input-border, var(--line));
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 10px;
      padding: 9px 10px;
      font-size: 12px;
      outline: none;
      width: 100%;
    }

    .input:focus,
    .select:focus,
    .textarea:focus {
      border-color: var(--active-border);
      box-shadow: 0 0 0 1px var(--active-border);
    }

    .textarea {
      min-height: 160px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1.45;
    }

    .modal-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      border-top: 1px solid var(--line);
      padding: 10px 12px;
    }

    .left-actions,
    .right-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .ghost-btn {
      background: var(--vscode-button-secondaryBackground);
      border-color: var(--line);
      color: var(--vscode-button-secondaryForeground);
    }

  </style>
</head>
<body>
  <main class="layout">
    <section class="header">
      <div class="brand">
        <div class="logo"><img class="logo-image" src="${iconUri}" alt="Agent Slayer" /></div>
        <div class="title">Agent Slayer</div>
      </div>
      <div class="header-right">
        <div id="version-badge" class="badge">v${this.escapeHtml(state.version)}</div>
        <button id="create-btn" class="create-btn" type="button" aria-label="Create New Prompt">Add</button>
      </div>
    </section>

    <section class="list-wrap">
      <div class="list-separator"></div>
      <div id="prompt-list" class="list"></div>
    </section>

    <section class="bottom">
      <button id="sync-btn" class="action-btn" type="button">Sync</button>
      <button id="marketplace-btn" class="action-btn" type="button">Marketplace</button>
    </section>

    <div id="toast" class="toast"></div>

    <div id="context-menu" class="context-menu" role="menu" aria-label="Prompt actions">
      <button id="context-activate" class="context-item" type="button" role="menuitem">Activate</button>
      <button id="context-edit" class="context-item" type="button" role="menuitem">Edit</button>
      <button id="context-delete" class="context-item" type="button" role="menuitem">Delete</button>
    </div>
  </main>

  <div id="modal-backdrop" class="modal-backdrop">
    <section class="modal-card" role="dialog" aria-modal="true" aria-label="Create Prompt">
      <header class="modal-head">
        <div id="modal-title" class="modal-title">Create New Prompt</div>
        <button id="modal-close" type="button" class="ghost-btn">Close</button>
      </header>

      <div class="modal-body">
        <div class="field">
          <label class="label" for="prompt-name">Prompt Name</label>
          <input id="prompt-name" class="input" type="text" />
        </div>

        <div class="field">
          <label class="label" for="prompt-category">Category</label>
          <select id="prompt-category" class="select">
            <option>Frontend</option>
            <option>Backend</option>
            <option>DevOps</option>
            <option>Security</option>
            <option>Testing</option>
            <option>Architecture</option>
            <option selected>General</option>
          </select>
        </div>

        <div class="field">
          <label class="label" for="prompt-description">Description</label>
          <input id="prompt-description" class="input" type="text" />
        </div>

        <div class="field">
          <label class="label" for="prompt-content">Prompt Content</label>
          <textarea
            id="prompt-content"
            class="textarea"
            rows="8"
            placeholder="You are a [role] expert. When helping with code..."
          ></textarea>
        </div>

        <div class="field">
          <label class="label" for="prompt-tags">Tags (comma separated)</label>
          <input id="prompt-tags" class="input" type="text" />
        </div>
      </div>

      <footer class="modal-actions">
        <div class="left-actions"></div>
        <div class="right-actions">
          <button id="modal-cancel" type="button" class="ghost-btn">Cancel</button>
          <button id="modal-save" type="button" class="modal-btn">Save Prompt</button>
        </div>
      </footer>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let appState = ${initialState};
    let contextFileName = '';
    let toastTimer = 0;
    let editMode = {
      mode: 'create',
      fileName: ''
    };

    const promptList = document.getElementById('prompt-list');
    const syncBtn = document.getElementById('sync-btn');
    const marketplaceBtn = document.getElementById('marketplace-btn');
    const createBtn = document.getElementById('create-btn');
    const toast = document.getElementById('toast');
    const contextMenu = document.getElementById('context-menu');
    const contextActivate = document.getElementById('context-activate');
    const contextEdit = document.getElementById('context-edit');
    const contextDelete = document.getElementById('context-delete');

    const modalBackdrop = document.getElementById('modal-backdrop');
    const modalTitle = document.getElementById('modal-title');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalSave = document.getElementById('modal-save');

    const promptNameInput = document.getElementById('prompt-name');
    const promptCategoryInput = document.getElementById('prompt-category');
    const promptDescriptionInput = document.getElementById('prompt-description');
    const promptContentInput = document.getElementById('prompt-content');
    const promptTagsInput = document.getElementById('prompt-tags');

    function shortDescription(value) {
      const text = String(value || '').trim();
      if (text.length <= 40) {
        return text;
      }

      return text.slice(0, 37).trimEnd() + '...';
    }

    function closeContextMenu() {
      if (!contextMenu) {
        return;
      }

      contextMenu.classList.remove('open');
      contextFileName = '';
    }

    function openContextMenu(fileName, clientX, clientY) {
      if (!contextMenu) {
        return;
      }

      contextFileName = fileName;
      contextMenu.classList.add('open');

      const width = contextMenu.offsetWidth || 110;
      const height = contextMenu.offsetHeight || 110;
      const left = Math.max(8, Math.min(clientX, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(clientY, window.innerHeight - height - 8));

      contextMenu.style.left = String(left) + 'px';
      contextMenu.style.top = String(top) + 'px';
    }

    function createPromptCard(prompt, index) {
      const isActive = prompt.fileName === appState.activePromptFile;
      const card = document.createElement('article');
      card.className = 'prompt-card prompt-enter' + (isActive ? ' active' : '');

      card.style.animationDelay = String(index * 50) + 'ms';
      card.dataset.fileName = prompt.fileName;

      const head = document.createElement('div');
      head.className = 'prompt-head';

      const title = document.createElement('div');
      title.className = 'prompt-name';
      title.textContent = prompt.name;

      const description = document.createElement('div');
      description.className = 'prompt-description';
      description.textContent = shortDescription(prompt.description);

      const tagRow = document.createElement('div');
      tagRow.className = 'prompt-tags';
      (Array.isArray(prompt.tags) ? prompt.tags : []).slice(0, 3).forEach((tagText) => {
        const t = document.createElement('span');
        t.className = 'tag-pill';
        t.textContent = String(tagText);
        tagRow.append(t);
      });

      if (isActive && tagRow.children.length) {
        tagRow.style.display = 'inline-flex';
      }

      head.append(title, description, tagRow);

      card.addEventListener('click', (event) => {
        if (!(event.target instanceof HTMLElement)) {
          return;
        }

        if (prompt.fileName === appState.activePromptFile) {
          return;
        }

        setActivePrompt(prompt.fileName);
        vscode.postMessage({ command: 'activatePrompt', fileName: prompt.fileName });
      });

      card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openContextMenu(prompt.fileName, event.clientX, event.clientY);
      });

      card.append(head);

      return card;
    }

    function renderPromptList(pulseFile) {
      promptList.innerHTML = '';

      if (!appState.prompts.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No .prompt.md files found in prompts/.';
        promptList.append(empty);
        return;
      }

      appState.prompts.forEach((prompt, index) => {
        const node = createPromptCard(prompt, index);
        if (pulseFile && pulseFile === prompt.fileName) {
          node.classList.add('pulse');
        }
        promptList.append(node);
      });
    }

    function setActivePrompt(fileName) {
      const activePrompt = appState.prompts.find((prompt) => prompt.fileName === fileName);
      if (!activePrompt) {
        return;
      }

      appState = {
        ...appState,
        activePromptFile: fileName,
        activePrompt
      };

      updatePromptSelection();
    }

    function updatePromptSelection() {
      const cards = promptList.querySelectorAll('.prompt-card');
      cards.forEach((card) => {
        const fileName = card.dataset.fileName;
        const active = fileName === appState.activePromptFile;
        card.classList.toggle('active', active);
      });
    }

    function showToast(message, isError) {
      if (toastTimer) {
        window.clearTimeout(toastTimer);
      }

      toast.textContent = message;
      toast.classList.toggle('error', !!isError);
      toast.classList.add('show');
      toastTimer = window.setTimeout(() => {
        toast.classList.remove('show');
      }, 2300);
    }

    function openEditor(mode, prompt) {
      editMode = {
        mode,
        fileName: mode === 'edit' && prompt ? prompt.fileName : ''
      };

      modalTitle.textContent = mode === 'edit' ? 'Edit Prompt' : 'Create New Prompt';

      promptNameInput.value = prompt ? prompt.name : '';
      promptCategoryInput.value = prompt && prompt.category ? prompt.category : 'General';
      promptDescriptionInput.value = prompt ? prompt.description : '';
      promptContentInput.value = prompt ? prompt.content : '';
      promptTagsInput.value = prompt && Array.isArray(prompt.tags) ? prompt.tags.join(', ') : '';

      modalBackdrop.classList.add('open');
      window.setTimeout(() => {
        promptNameInput.focus();
      }, 20);
    }

    function closeEditor() {
      modalBackdrop.classList.remove('open');
    }

    function collectFormPayload() {
      return {
        name: promptNameInput.value || '',
        category: promptCategoryInput.value || 'General',
        description: promptDescriptionInput.value || '',
        content: promptContentInput.value || '',
        tags: promptTagsInput.value || ''
      };
    }

    function savePrompt() {
      const payload = collectFormPayload();
      if (!payload.name.trim() || !payload.content.trim()) {
        showToast('Name and content are required.', true);
        return;
      }

      if (editMode.mode === 'edit') {
        vscode.postMessage({
          command: 'updatePrompt',
          fileName: editMode.fileName,
          prompt: payload
        });
      } else {
        vscode.postMessage({ command: 'createPrompt', prompt: payload });
      }
    }

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLElement)) {
        closeContextMenu();
        return;
      }

      if (!event.target.closest('#context-menu')) {
        closeContextMenu();
      }
    });

    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);

    contextActivate.addEventListener('click', () => {
      if (!contextFileName) {
        return;
      }

      const fileName = contextFileName;
      closeContextMenu();
      if (fileName === appState.activePromptFile) {
        return;
      }

      setActivePrompt(fileName);
      vscode.postMessage({ command: 'activatePrompt', fileName });
    });

    contextEdit.addEventListener('click', () => {
      if (!contextFileName) {
        return;
      }

      const prompt = appState.prompts.find((item) => item.fileName === contextFileName);
      closeContextMenu();
      if (prompt) {
        openEditor('edit', prompt);
      }
    });

    contextDelete.addEventListener('click', () => {
      if (!contextFileName) {
        return;
      }

      const fileName = contextFileName;
      closeContextMenu();
      if (window.confirm('Delete this prompt?')) {
        vscode.postMessage({ command: 'deletePrompt', fileName });
      }
    });

    syncBtn.addEventListener('click', (event) => {
      vscode.postMessage({ command: 'sync' });
    });

    marketplaceBtn.addEventListener('click', (event) => {
      vscode.postMessage({ command: 'openMarketplace' });
    });

    createBtn.addEventListener('click', () => {
      openEditor('create');
    });

    modalClose.addEventListener('click', closeEditor);
    modalCancel.addEventListener('click', closeEditor);
    modalSave.addEventListener('click', savePrompt);

    modalBackdrop.addEventListener('click', (event) => {
      if (event.target === modalBackdrop) {
        closeEditor();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.command === 'state' && message.state) {
        const previous = appState;
        const nextState = message.state;
        const previousPrompts = Array.isArray(previous.prompts) ? previous.prompts : [];
        const nextPrompts = Array.isArray(nextState.prompts) ? nextState.prompts : [];
        const listChanged =
          previousPrompts.length !== nextPrompts.length ||
          previousPrompts.some((item, index) => {
            const next = nextPrompts[index];
            return (
              !next ||
              item.fileName !== next.fileName ||
              item.name !== next.name ||
              item.description !== next.description ||
              item.category !== next.category
            );
          });

        appState = nextState;
        closeContextMenu();

        if (message.pulseFile || listChanged) {
          renderPromptList(message.pulseFile || '');
        } else {
          updatePromptSelection();
        }

        if (modalBackdrop.classList.contains('open') && !message.pulseFile) {
          // keep modal open while editing
        } else if (message.pulseFile) {
          closeEditor();
        }
      }

      if (message.command === 'toast') {
        showToast(message.message || '', !!message.isError);
      }
    });

    renderPromptList('');
  </script>
</body>
</html>`;
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
    return Array.from({ length: 32 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join('');
  }
}
