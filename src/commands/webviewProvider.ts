import * as path from 'path';
import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as https from 'https';
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
  | { command: 'duplicatePrompt'; fileName: string }
  | { command: 'enhancePrompt'; requestId: string; content: string };

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

const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

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

    if (message.command === 'enhancePrompt') {
      await this.enhancePrompt(message.requestId, message.content);
    }
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

    if (
      msg.command === 'enhancePrompt' &&
      typeof msg.requestId === 'string' &&
      typeof msg.content === 'string'
    ) {
      return {
        command: 'enhancePrompt',
        requestId: msg.requestId,
        content: msg.content,
      };
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

  private async enhancePrompt(requestId: string, content: string): Promise<void> {
    if (!this.view) {
      return;
    }

    const apiKey = this.getAnthropicApiKey();
    if (!apiKey) {
      await this.view.webview.postMessage({
        command: 'enhanceError',
        requestId,
        error: 'Missing Anthropic API key. Set ANTHROPIC_API_KEY or agentSlayer.anthropicApiKey.',
      });
      return;
    }

    await this.view.webview.postMessage({ command: 'enhanceStart', requestId });

    try {
      await this.streamEnhancedPrompt(apiKey, requestId, content);
      await this.view.webview.postMessage({ command: 'enhanceDone', requestId });
    } catch (error) {
      log('Prompt enhancement failed: ' + String(error));
      await this.view.webview.postMessage({
        command: 'enhanceError',
        requestId,
        error: 'AI enhancement failed. Check API key or network.',
      });
    }
  }

  private getAnthropicApiKey(): string {
    const cfg = vscode.workspace.getConfiguration('agentSlayer');
    const fromSettings = cfg.get<string>('anthropicApiKey', '').trim();
    const fromEnv = (process.env.ANTHROPIC_API_KEY || '').trim();
    return fromSettings || fromEnv;
  }

  private streamEnhancedPrompt(
    apiKey: string,
    requestId: string,
    sourceContent: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200,
        stream: true,
        system:
          'You are an expert prompt engineer. Rewrite user prompts to be clearer, actionable, and effective while preserving intent. Return only the improved prompt body.',
        messages: [
          {
            role: 'user',
            content:
              'Improve this coding-assistant prompt while preserving intent:\n\n' +
              sourceContent,
          },
        ],
      });

      const request = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-length': Buffer.byteLength(payload),
          },
          timeout: 30000,
        },
        (response) => {
          if (!response.statusCode || response.statusCode >= 400) {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', () => {
              reject(
                new Error(
                  'Anthropic HTTP ' +
                    String(response.statusCode ?? 0) +
                    ' ' +
                    Buffer.concat(chunks).toString('utf8')
                )
              );
            });
            return;
          }

          let sseBuffer = '';
          response.on('data', (chunk) => {
            sseBuffer += Buffer.isBuffer(chunk)
              ? chunk.toString('utf8')
              : String(chunk);

            let boundary = sseBuffer.indexOf('\n\n');
            while (boundary !== -1) {
              const eventBlock = sseBuffer.slice(0, boundary);
              sseBuffer = sseBuffer.slice(boundary + 2);
              this.consumeAnthropicEventBlock(eventBlock, requestId);
              boundary = sseBuffer.indexOf('\n\n');
            }
          });

          response.on('end', () => {
            if (sseBuffer.trim()) {
              this.consumeAnthropicEventBlock(sseBuffer, requestId);
            }
            resolve();
          });

          response.on('error', (error) => {
            reject(error);
          });
        }
      );

      request.on('timeout', () => {
        request.destroy(new Error('Anthropic request timeout'));
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.write(payload);
      request.end();
    });
  }

  private consumeAnthropicEventBlock(eventBlock: string, requestId: string): void {
    if (!this.view) {
      return;
    }

    const lines = eventBlock.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const type = typeof parsed.type === 'string' ? parsed.type : '';
        if (type !== 'content_block_delta') {
          continue;
        }

        const delta = parsed.delta as Record<string, unknown> | undefined;
        const text = delta && typeof delta.text === 'string' ? delta.text : '';
        if (!text) {
          continue;
        }

        void this.view.webview.postMessage({
          command: 'enhanceChunk',
          requestId,
          chunk: text,
        });
      } catch {
        // Ignore malformed event lines.
      }
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
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agent-slayer-activity.svg'))
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
      --card: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.4)));
      --accent: var(--vscode-focusBorder);
      --highlight: var(--vscode-textLink-foreground);
      --text: var(--vscode-sideBar-foreground);
      --muted: var(--vscode-descriptionForeground);
      --shadow: 0 0 0 rgba(0, 0, 0, 0);
      --danger: var(--vscode-inputValidation-errorForeground, #fda4af);
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
      font-family: system-ui, -apple-system, Segoe UI, sans-serif;
      overflow: hidden;
    }

    .layout {
      height: 100%;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 12px;
      padding: 14px;
      position: relative;
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
    }

    .header {
      padding: 12px;
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
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badge {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--highlight);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.03em;
    }

    .section-label {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .fade-in {
      animation: fadeIn 150ms ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .list-wrap {
      overflow: hidden;
      min-height: 0;
      display: grid;
      gap: 8px;
    }

    .list {
      overflow: auto;
      min-height: 0;
      display: grid;
      gap: 10px;
      padding-right: 2px;
      padding-bottom: 108px;
    }

    .list::-webkit-scrollbar {
      width: 8px;
    }

    .list::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 999px;
    }

    .prompt-card {
      position: relative;
      padding: 11px;
      display: grid;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--card);
      transition: transform 200ms ease, box-shadow 200ms ease, border-color 200ms ease;
      box-shadow: var(--shadow);
      overflow: hidden;
      min-height: 92px;
    }

    .prompt-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.2);
      border-color: var(--accent);
    }

    .prompt-card.active {
      border-color: var(--accent);
    }

    .prompt-card.active::before {
      content: '';
      position: absolute;
      top: 8px;
      left: 0;
      width: 3px;
      height: calc(100% - 16px);
      border-radius: 0 10px 10px 0;
      background: linear-gradient(180deg, var(--accent), var(--highlight));
      box-shadow: 0 0 8px rgba(0, 0, 0, 0.22);
    }

    .prompt-card.pulse {
      animation: pulsePurple 550ms ease;
    }

    @keyframes pulsePurple {
      0% { box-shadow: 0 0 0 rgba(192, 132, 252, 0); }
      40% { box-shadow: 0 0 0 4px rgba(192, 132, 252, 0.34); }
      100% { box-shadow: 0 0 0 rgba(192, 132, 252, 0); }
    }

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
      gap: 10px;
      min-width: 0;
      padding-right: 30px;
    }

    .icon {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--accent);
      display: grid;
      place-items: center;
      font-size: 10px;
      text-transform: uppercase;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      flex-shrink: 0;
    }

    .prompt-name {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .prompt-description {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .prompt-meta {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .pill {
      font-size: 11px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      padding: 2px 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .activate-btn,
    .action-btn,
    .modal-btn,
    .ghost-btn,
    .menu-item,
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

    .activate-btn:hover,
    .action-btn:hover,
    .modal-btn:hover,
    .ghost-btn:hover,
    .menu-item:hover,
    .confirm-btn:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .activate-btn.is-active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-border, transparent);
    }

    .menu-trigger {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 22px;
      height: 22px;
      border-radius: 7px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 150ms ease, transform 150ms ease, background 150ms ease;
      font-size: 13px;
      line-height: 1;
      z-index: 3;
    }

    .menu-trigger:hover {
      background: var(--vscode-list-hoverBackground, var(--card));
    }

    .menu {
      position: absolute;
      top: 34px;
      right: 8px;
      display: none;
      min-width: 120px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--card);
      padding: 6px;
      z-index: 4;
      box-shadow: 0 10px 22px rgba(0, 0, 0, 0.45);
    }

    .menu.open {
      display: grid;
      gap: 4px;
    }

    .menu-item {
      background: var(--vscode-button-secondaryBackground);
      text-align: left;
      padding: 6px 8px;
      font-size: 12px;
      width: 100%;
    }

    .delete-confirm {
      border: 1px dashed var(--vscode-inputValidation-errorBorder, var(--border));
      background: var(--vscode-inputValidation-errorBackground, var(--card));
      border-radius: 8px;
      padding: 9px;
      display: grid;
      gap: 8px;
      font-size: 12px;
      color: var(--vscode-inputValidation-errorForeground, var(--danger));
    }

    .confirm-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .confirm-btn.no {
      border-color: var(--border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .confirm-btn.yes {
      border-color: var(--vscode-inputValidation-errorBorder, var(--border));
      background: var(--vscode-inputValidation-errorBackground, var(--card));
      color: var(--vscode-inputValidation-errorForeground, var(--danger));
    }

    .ripple {
      position: absolute;
      border-radius: 999px;
      transform: scale(0);
      animation: ripple 420ms ease-out;
      background: rgba(248, 250, 252, 0.38);
      pointer-events: none;
    }

    @keyframes ripple {
      to {
        transform: scale(4);
        opacity: 0;
      }
    }

    .bottom {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px;
    }

    .empty {
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 14px;
      font-size: 12px;
      color: var(--muted);
      text-align: center;
      background: var(--card);
    }

    .fab {
      position: absolute;
      right: 18px;
      bottom: 68px;
      width: 44px;
      height: 44px;
      border-radius: 999px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 24px;
      line-height: 0;
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
      transition: transform 180ms ease, box-shadow 180ms ease;
      z-index: 5;
    }

    .fab:hover {
      transform: scale(1.1);
      box-shadow: 0 0 16px rgba(0, 0, 0, 0.4);
    }

    .toast {
      position: absolute;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%) translateY(12px);
      background: var(--vscode-notifications-background, var(--card));
      border: 1px solid var(--border);
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
      border-color: var(--vscode-inputValidation-errorBorder, var(--border));
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
      border: 1px solid var(--border);
      background: var(--card);
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
      border-bottom: 1px solid var(--border);
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
      border: 1px solid var(--vscode-input-border, var(--border));
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
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
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
      border-top: 1px solid var(--border);
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
      border-color: var(--border);
      color: var(--vscode-button-secondaryForeground);
    }

    .ai-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .sparkle {
      font-size: 13px;
      line-height: 1;
    }

    .ai-btn.loading {
      pointer-events: none;
      opacity: 0.9;
    }

    .ai-btn.loading .sparkle {
      animation: spinSpark 850ms linear infinite;
    }

    @keyframes spinSpark {
      to {
        transform: rotate(360deg);
      }
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="card header">
      <div class="brand">
        <div class="logo"><img class="logo-image" src="${iconUri}" alt="Agent Slayer" /></div>
        <div class="title">Agent Slayer</div>
      </div>
      <div id="version-badge" class="badge">v${this.escapeHtml(state.version)}</div>
    </section>

    <section class="list-wrap">
      <div class="section-label">Prompt List</div>
      <div id="prompt-list" class="list"></div>
    </section>

    <section class="card bottom">
      <button id="sync-btn" class="action-btn" type="button">Sync</button>
      <button id="marketplace-btn" class="action-btn" type="button">Marketplace</button>
    </section>

    <button id="create-fab" class="fab" type="button" aria-label="Create New Prompt">+</button>
    <div id="toast" class="toast"></div>
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
        <div class="left-actions">
          <button id="ai-enhance-btn" type="button" class="modal-btn ai-btn">
            <span class="sparkle">&#10022;</span>
            AI Enhance
          </button>
        </div>
        <div class="right-actions">
          <button id="modal-cancel" type="button" class="ghost-btn">Cancel</button>
          <button id="modal-save" type="button" class="modal-btn">Save Prompt</button>
        </div>
      </footer>
    </section>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const iconLabels = {
      shield: 'SEC',
      beaker: 'TST',
      bug: 'DBG',
      database: 'DB',
      arrows: 'MIG',
      api: 'API',
      spark: 'NEW',
      file: 'DOC'
    };

    let appState = ${initialState};
    let openMenuFile = '';
    let deleteConfirmFile = '';
    let toastTimer = 0;
    let editMode = {
      mode: 'create',
      fileName: ''
    };

    let currentEnhanceRequest = '';
    let typingQueue = '';
    let typingTimer = 0;

    const promptList = document.getElementById('prompt-list');
    const syncBtn = document.getElementById('sync-btn');
    const marketplaceBtn = document.getElementById('marketplace-btn');
    const createFab = document.getElementById('create-fab');
    const toast = document.getElementById('toast');

    const modalBackdrop = document.getElementById('modal-backdrop');
    const modalTitle = document.getElementById('modal-title');
    const modalClose = document.getElementById('modal-close');
    const modalCancel = document.getElementById('modal-cancel');
    const modalSave = document.getElementById('modal-save');
    const aiEnhanceBtn = document.getElementById('ai-enhance-btn');

    const promptNameInput = document.getElementById('prompt-name');
    const promptCategoryInput = document.getElementById('prompt-category');
    const promptDescriptionInput = document.getElementById('prompt-description');
    const promptContentInput = document.getElementById('prompt-content');
    const promptTagsInput = document.getElementById('prompt-tags');

    function createPromptCard(prompt, index) {
      const isActive = prompt.fileName === appState.activePromptFile;
      const card = document.createElement('article');
      card.className = 'prompt-card prompt-enter' + (isActive ? ' active' : '');
      if (openMenuFile === prompt.fileName) {
        card.classList.add('menu-open');
      }

      card.style.animationDelay = String(index * 50) + 'ms';
      card.dataset.fileName = prompt.fileName;

      const menuTrigger = document.createElement('button');
      menuTrigger.type = 'button';
      menuTrigger.className = 'menu-trigger';
      menuTrigger.textContent = '\u22EF';
      menuTrigger.setAttribute('aria-label', 'Prompt actions');
      menuTrigger.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenuFile = openMenuFile === prompt.fileName ? '' : prompt.fileName;
        deleteConfirmFile = '';
        renderPromptList();
      });

      const menu = document.createElement('div');
      menu.className = 'menu' + (openMenuFile === prompt.fileName ? ' open' : '');
      menu.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'menu-item';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenuFile = '';
        openEditor('edit', prompt);
      });

      const duplicateBtn = document.createElement('button');
      duplicateBtn.type = 'button';
      duplicateBtn.className = 'menu-item';
      duplicateBtn.textContent = 'Duplicate';
      duplicateBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenuFile = '';
        vscode.postMessage({ command: 'duplicatePrompt', fileName: prompt.fileName });
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'menu-item';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openMenuFile = '';
        deleteConfirmFile = prompt.fileName;
        renderPromptList();
      });

      menu.append(editBtn, duplicateBtn, deleteBtn);

      const head = document.createElement('div');
      head.className = 'prompt-head';

      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = iconLabels[prompt.icon] || iconLabels.file;

      const textWrap = document.createElement('div');
      textWrap.style.minWidth = '0';

      const title = document.createElement('div');
      title.className = 'prompt-name';
      title.textContent = prompt.name;

      const description = document.createElement('div');
      description.className = 'prompt-description';
      description.textContent = prompt.description;

      const meta = document.createElement('div');
      meta.className = 'prompt-meta';

      const cat = document.createElement('span');
      cat.className = 'pill';
      cat.textContent = prompt.category || 'General';
      meta.append(cat);

      (Array.isArray(prompt.tags) ? prompt.tags : []).slice(0, 2).forEach((tagText) => {
        const t = document.createElement('span');
        t.className = 'pill';
        t.textContent = tagText;
        meta.append(t);
      });

      textWrap.append(title, description, meta);
      head.append(icon, textWrap);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'activate-btn' + (isActive ? ' is-active' : '');
      button.textContent = isActive ? 'Active' : 'Activate';
      button.dataset.fileName = prompt.fileName;
      button.addEventListener('click', (event) => {
        createRipple(event.currentTarget, event);
        const fileName = button.dataset.fileName;
        if (!fileName || fileName === appState.activePromptFile) {
          return;
        }

        setActivePrompt(fileName, true);
        vscode.postMessage({ command: 'activatePrompt', fileName });
      });

      card.append(menuTrigger, menu, head);

      if (deleteConfirmFile === prompt.fileName) {
        const confirm = document.createElement('div');
        confirm.className = 'delete-confirm';
        confirm.innerHTML = '<div>Delete? [Yes] [No]</div>';

        const actions = document.createElement('div');
        actions.className = 'confirm-actions';

        const noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'confirm-btn no';
        noBtn.textContent = 'No';
        noBtn.addEventListener('click', () => {
          deleteConfirmFile = '';
          renderPromptList();
        });

        const yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.className = 'confirm-btn yes';
        yesBtn.textContent = 'Yes';
        yesBtn.addEventListener('click', () => {
          deleteConfirmFile = '';
          vscode.postMessage({ command: 'deletePrompt', fileName: prompt.fileName });
        });

        actions.append(noBtn, yesBtn);
        confirm.append(actions);
        card.append(confirm);
      } else {
        card.append(button);
      }

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

    function setActivePrompt(fileName, animate) {
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

        const button = card.querySelector('.activate-btn');
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }

        button.classList.toggle('is-active', active);
        button.textContent = active ? 'Active' : 'Activate';
      });
    }

    function createRipple(target, event) {
      if (!(target instanceof HTMLElement) || !(event instanceof MouseEvent)) {
        return;
      }

      const rect = target.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);

      ripple.className = 'ripple';
      ripple.style.width = String(size) + 'px';
      ripple.style.height = String(size) + 'px';
      ripple.style.left = String(event.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = String(event.clientY - rect.top - size / 2) + 'px';

      target.querySelectorAll('.ripple').forEach((existing) => existing.remove());
      target.append(ripple);
      window.setTimeout(() => ripple.remove(), 450);
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
      stopTypingAnimation();
      currentEnhanceRequest = '';
      aiEnhanceBtn.classList.remove('loading');
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

    function requestEnhance() {
      const content = promptContentInput.value.trim();
      if (!content) {
        showToast('Add prompt content before AI Enhance.', true);
        return;
      }

      currentEnhanceRequest = 'req-' + String(Date.now()) + '-' + String(Math.random());
      typingQueue = '';
      promptContentInput.value = '';
      aiEnhanceBtn.classList.add('loading');
      vscode.postMessage({
        command: 'enhancePrompt',
        requestId: currentEnhanceRequest,
        content
      });
    }

    function startTypingAnimation() {
      if (typingTimer) {
        return;
      }

      typingTimer = window.setInterval(() => {
        if (!typingQueue) {
          if (!currentEnhanceRequest) {
            stopTypingAnimation();
          }
          return;
        }

        const next = typingQueue.slice(0, 2);
        typingQueue = typingQueue.slice(next.length);
        promptContentInput.value += next;
        promptContentInput.scrollTop = promptContentInput.scrollHeight;
      }, 12);
    }

    function stopTypingAnimation() {
      if (typingTimer) {
        window.clearInterval(typingTimer);
        typingTimer = 0;
      }
    }

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLElement)) {
        return;
      }

      if (!event.target.closest('.menu') && !event.target.closest('.menu-trigger')) {
        if (openMenuFile) {
          openMenuFile = '';
          renderPromptList();
        }
      }
    });

    syncBtn.addEventListener('click', (event) => {
      createRipple(syncBtn, event);
      vscode.postMessage({ command: 'sync' });
    });

    marketplaceBtn.addEventListener('click', (event) => {
      createRipple(marketplaceBtn, event);
      vscode.postMessage({ command: 'openMarketplace' });
    });

    createFab.addEventListener('click', (event) => {
      createRipple(createFab, event);
      openEditor('create');
    });

    modalClose.addEventListener('click', closeEditor);
    modalCancel.addEventListener('click', closeEditor);
    modalSave.addEventListener('click', savePrompt);
    aiEnhanceBtn.addEventListener('click', requestEnhance);

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
        appState = message.state;
        renderPromptList(message.pulseFile || '');

        if (modalBackdrop.classList.contains('open') && !message.pulseFile) {
          // keep modal open while editing
        } else if (message.pulseFile) {
          closeEditor();
        }
      }

      if (message.command === 'toast') {
        showToast(message.message || '', !!message.isError);
      }

      if (message.command === 'enhanceStart' && message.requestId === currentEnhanceRequest) {
        typingQueue = '';
        promptContentInput.value = '';
        startTypingAnimation();
      }

      if (message.command === 'enhanceChunk' && message.requestId === currentEnhanceRequest) {
        typingQueue += String(message.chunk || '');
        startTypingAnimation();
      }

      if (message.command === 'enhanceDone' && message.requestId === currentEnhanceRequest) {
        currentEnhanceRequest = '';
        aiEnhanceBtn.classList.remove('loading');
      }

      if (message.command === 'enhanceError' && message.requestId === currentEnhanceRequest) {
        currentEnhanceRequest = '';
        aiEnhanceBtn.classList.remove('loading');
        showToast(message.error || 'AI enhancement failed.', true);
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
