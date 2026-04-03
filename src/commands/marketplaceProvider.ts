import * as path from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import * as vscode from 'vscode';
import { log } from '../utils/logger';

interface MarketplacePrompt {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  stars: number;
  tags: string[];
  content: string;
}

interface UiPrompt extends MarketplacePrompt {
  localId: string;
}

interface ReadyMessage {
  command: 'ready';
}

interface RefreshMessage {
  command: 'refresh';
}

interface InstallMessage {
  command: 'install';
  localId: string;
}

type IncomingMessage = ReadyMessage | RefreshMessage | InstallMessage;

interface MarketplacePayload {
  prompts: UiPrompt[];
  installedIds: string[];
  sourceUrl: string;
}

interface ParsedPromptFile {
  metadata: Record<string, string>;
  content: string;
}

interface RemoteMarketplaceResult {
  prompts: UiPrompt[];
  sourceUrl: string;
}

const OPEN_MARKETPLACE_COMMAND = 'agentSlayer.openMarketplace';

export class AgentSlayerMarketplaceProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, UiPrompt>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AgentSlayerMarketplaceProvider(context);
    const command = vscode.commands.registerCommand(
      OPEN_MARKETPLACE_COMMAND,
      async () => {
        await provider.open();
      }
    );

    context.subscriptions.push(provider, command);
    return new vscode.Disposable(() => {
      provider.dispose();
      command.dispose();
    });
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }

  private async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One, true);
      await this.loadAndPostState(this.panel.webview);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentSlayer.marketplace',
      'Agent Slayer Marketplace',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);

    const onMessage = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const parsed = this.parseIncomingMessage(message);
      if (!parsed) {
        return;
      }

      await this.handleMessage(parsed, panel.webview);
    });

    const onDispose = panel.onDidDispose(() => {
      onMessage.dispose();
      onDispose.dispose();

      if (this.panel === panel) {
        this.panel = undefined;
      }
    });

    this.disposables.push(onMessage, onDispose);
    this.context.subscriptions.push(onMessage, onDispose);

    await this.loadAndPostState(panel.webview);
  }

  private parseIncomingMessage(message: unknown): IncomingMessage | null {
    if (!message || typeof message !== 'object') {
      return null;
    }

    const payload = message as Record<string, unknown>;
    if (payload.command === 'ready') {
      return { command: 'ready' };
    }

    if (payload.command === 'refresh') {
      return { command: 'refresh' };
    }

    if (payload.command === 'install' && typeof payload.localId === 'string') {
      return { command: 'install', localId: payload.localId };
    }

    return null;
  }

  private async handleMessage(
    message: IncomingMessage,
    webview: vscode.Webview
  ): Promise<void> {
    if (message.command === 'ready' || message.command === 'refresh') {
      await this.loadAndPostState(webview);
      return;
    }

    if (message.command === 'install') {
      await this.installPrompt(message.localId, webview);
    }
  }

  private async loadAndPostState(webview: vscode.Webview): Promise<void> {
    try {
      const installedIds = await this.getInstalledPromptIds();
      const localPrompts = await this.getLocalMarketplacePrompts();

      let remotePrompts: UiPrompt[] = [];
      let sourceLabel = 'Local workspace prompts';

      try {
        const remote = await this.fetchPromptsFromCandidates();
        remotePrompts = remote.prompts;
        sourceLabel = remote.sourceUrl;
      } catch (error) {
        sourceLabel = 'Local workspace prompts (remote unavailable)';
        log('Marketplace remote fetch failed, using local prompts. ' + String(error));
      }

      const prompts = this.mergePrompts(remotePrompts, localPrompts);

      this.cache.clear();
      for (const prompt of prompts) {
        this.cache.set(prompt.localId, prompt);
      }

      const payload: MarketplacePayload = {
        prompts,
        installedIds,
        sourceUrl: sourceLabel,
      };

      await webview.postMessage({ command: 'data', payload });
    } catch (error) {
      const message = 'Agent Slayer: Could not load marketplace prompts.';
      log(message + ' ' + String(error));
      await webview.postMessage({
        command: 'error',
        error: message,
      });
    }
  }

  private async fetchPromptsFromCandidates(): Promise<RemoteMarketplaceResult> {
    const candidates = this.getMarketplaceCandidateUrls();
    if (!candidates.length) {
      throw new Error('No marketplace feed URL candidates were found.');
    }

    let lastError: unknown;
    for (const url of candidates) {
      try {
        const prompts = await this.fetchPrompts(url);
        return { prompts, sourceUrl: url };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Unable to fetch marketplace feed from candidate URLs.');
  }

  private getMarketplaceCandidateUrls(): string[] {
    const cfg = vscode.workspace.getConfiguration('agentSlayer');
    const candidates: string[] = [];

    const configuredFeedUrl = cfg.get<string>('marketplaceFeedUrl', '').trim();
    if (configuredFeedUrl) {
      candidates.push(this.toRawGitHubUrl(configuredFeedUrl));
    }

    const repositoryUrl = this.getRepositoryUrl();
    if (repositoryUrl) {
      const rawRepoUrl = this.toRawGitHubUrl(repositoryUrl);
      if (rawRepoUrl.endsWith('.json')) {
        candidates.push(rawRepoUrl);
      }

      const repo = this.parseGitHubRepo(repositoryUrl);
      if (repo) {
        for (const branch of ['main', 'master']) {
          candidates.push(
            'https://raw.githubusercontent.com/' +
              encodeURIComponent(repo.owner) +
              '/' +
              encodeURIComponent(repo.repo) +
              '/' +
              branch +
              '/prompts.json'
          );
          candidates.push(
            'https://raw.githubusercontent.com/' +
              encodeURIComponent(repo.owner) +
              '/' +
              encodeURIComponent(repo.repo) +
              '/' +
              branch +
              '/marketplace/prompts.json'
          );
          candidates.push(
            'https://raw.githubusercontent.com/' +
              encodeURIComponent(repo.owner) +
              '/' +
              encodeURIComponent(repo.repo) +
              '/' +
              branch +
              '/prompts/prompts.json'
          );
        }
      }
    }

    const configuredUser = cfg.get<string>('marketplaceUsername', '').trim();
    const publisherRaw =
      typeof this.context.extension.packageJSON?.publisher === 'string'
        ? this.context.extension.packageJSON.publisher
        : '';
    const publisher = publisherRaw.trim();
    const username = configuredUser || publisher;
    if (username) {
      candidates.push(
        'https://raw.githubusercontent.com/' +
          encodeURIComponent(username) +
          '/agent-slayer-marketplace/main/prompts.json'
      );
    }

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of candidates) {
      const value = item.trim();
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      unique.push(value);
    }

    return unique;
  }

  private getRepositoryUrl(): string {
    const pkg = this.context.extension.packageJSON as {
      repository?: { url?: unknown } | unknown;
    };
    const repository = pkg.repository;
    if (!repository) {
      return '';
    }

    if (typeof repository === 'string') {
      return repository.trim();
    }

    if (typeof repository === 'object' && repository !== null) {
      const candidate = (repository as { url?: unknown }).url;
      return typeof candidate === 'string' ? candidate.trim() : '';
    }

    return '';
  }

  private parseGitHubRepo(url: string): { owner: string; repo: string } | null {
    const normalized = url
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\//, 'https://')
      .replace(/\.git$/i, '');

    const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)/i);
    if (!match) {
      return null;
    }

    return {
      owner: match[1],
      repo: match[2],
    };
  }

  private toRawGitHubUrl(url: string): string {
    const normalized = url.trim().replace(/^git\+/, '').replace(/\.git$/i, '');
    if (!normalized) {
      return normalized;
    }

    const rawMatch = normalized.match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i
    );
    if (rawMatch) {
      return normalized;
    }

    const blobMatch = normalized.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i
    );
    if (blobMatch) {
      return (
        'https://raw.githubusercontent.com/' +
        blobMatch[1] +
        '/' +
        blobMatch[2] +
        '/' +
        blobMatch[3] +
        '/' +
        blobMatch[4]
      );
    }

    return normalized;
  }

  private fetchPrompts(url: string): Promise<UiPrompt[]> {
    return new Promise((resolve, reject) => {
      const request = https.get(url, { timeout: 12000 }, (response) => {
        if (!response.statusCode || response.statusCode >= 400) {
          reject(new Error('HTTP status ' + String(response.statusCode ?? 0)));
          response.resume();
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              reject(new Error('Invalid marketplace JSON shape'));
              return;
            }

            const prompts: UiPrompt[] = [];
            for (const item of parsed) {
              const prompt = this.toPrompt(item);
              if (prompt) {
                prompts.push(prompt);
              }
            }

            resolve(prompts);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('timeout', () => {
        request.destroy(new Error('Marketplace request timeout'));
      });

      request.on('error', (error) => {
        reject(error);
      });
    });
  }

  private toPrompt(item: unknown): UiPrompt | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const row = item as Record<string, unknown>;
    const id = this.stringOrDefault(row.id, 'untitled-prompt');
    const name = this.stringOrDefault(row.name, 'Untitled Prompt');
    const description = this.stringOrDefault(
      row.description,
      'No description available.'
    );
    const category = this.stringOrDefault(row.category, 'General');
    const author = this.stringOrDefault(row.author, 'unknown');
    const stars = this.numberOrDefault(row.stars, 0);
    const tags = Array.isArray(row.tags)
      ? row.tags
          .filter((tag) => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [];
    const content = this.stringOrDefault(row.content, 'You are a helpful assistant.');

    return {
      id,
      localId: this.toLocalId(id),
      name,
      description,
      category,
      author,
      stars,
      tags,
      content,
    };
  }

  private stringOrDefault(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  private numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private toLocalId(value: string): string {
    const normalized = value
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return normalized || 'prompt';
  }

  private async getInstalledPromptIds(): Promise<string[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return [];
    }

    const promptsDir = path.join(folder.uri.fsPath, 'prompts');

    try {
      const files = await fs.readdir(promptsDir, { withFileTypes: true });
      return files
        .filter((entry) => entry.isFile() && entry.name.endsWith('.prompt.md'))
        .map((entry) => entry.name.replace(/\.prompt\.md$/i, '').toLowerCase());
    } catch {
      return [];
    }
  }

  private mergePrompts(primary: UiPrompt[], secondary: UiPrompt[]): UiPrompt[] {
    const map = new Map<string, UiPrompt>();

    for (const prompt of primary) {
      map.set(prompt.localId, prompt);
    }

    for (const prompt of secondary) {
      if (!map.has(prompt.localId)) {
        map.set(prompt.localId, prompt);
      }
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async getLocalMarketplacePrompts(): Promise<UiPrompt[]> {
    const prompts: UiPrompt[] = [];
    for (const dir of this.getLocalPromptDirectories()) {
      const fromDir = await this.loadLocalPromptsFromDirectory(dir);
      prompts.push(...fromDir);
    }

    return this.mergePrompts(prompts, []);
  }

  private getLocalPromptDirectories(): string[] {
    const dirs: string[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      dirs.push(path.join(folder.uri.fsPath, 'prompts'));
    }

    dirs.push(path.join(this.context.extensionPath, 'prompts'));
    return dirs;
  }

  private async loadLocalPromptsFromDirectory(promptsDir: string): Promise<UiPrompt[]> {
    try {
      const files = await fs.readdir(promptsDir, { withFileTypes: true });
      const promptFiles = files.filter(
        (entry) => entry.isFile() && entry.name.endsWith('.prompt.md')
      );

      const prompts: UiPrompt[] = [];
      for (const entry of promptFiles) {
        const filePath = path.join(promptsDir, entry.name);
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = this.parsePromptFile(raw);

        const baseName = entry.name.replace(/\.prompt\.md$/i, '');
        const id = this.stringOrDefault(parsed.metadata.id, baseName);
        const localId = this.toLocalId(baseName);

        const tags = (parsed.metadata.tags ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);

        const stars = Number.parseInt(parsed.metadata.stars ?? '0', 10);

        prompts.push({
          id,
          localId,
          name: this.stringOrDefault(parsed.metadata.name, this.humanize(baseName)),
          description: this.stringOrDefault(
            parsed.metadata.description,
            this.extractSummary(parsed.content)
          ),
          category: this.stringOrDefault(parsed.metadata.category, 'General'),
          author: this.stringOrDefault(parsed.metadata.author, 'local'),
          stars: Number.isFinite(stars) ? stars : 0,
          tags,
          content: this.stringOrDefault(parsed.content, 'You are a helpful assistant.'),
        });
      }

      return prompts;
    } catch {
      return [];
    }
  }

  private parsePromptFile(raw: string): ParsedPromptFile {
    const frontmatter = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!frontmatter) {
      return { metadata: {}, content: raw.trim() };
    }

    const metadata: Record<string, string> = {};
    const metaBlock = frontmatter[1];
    for (const line of metaBlock.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator <= 0) {
        continue;
      }

      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (key) {
        metadata[key] = value;
      }
    }

    const content = raw.slice(frontmatter[0].length).trim();
    return { metadata, content };
  }

  private extractSummary(content: string): string {
    const firstLine = content.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) {
      return 'No description available.';
    }

    return firstLine.trim().slice(0, 140);
  }

  private humanize(value: string): string {
    return value
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private async installPrompt(localId: string, webview: vscode.Webview): Promise<void> {
    const prompt = this.cache.get(localId);
    if (!prompt) {
      await webview.postMessage({
        command: 'installResult',
        ok: false,
        localId,
        error: 'Prompt not found in marketplace cache.',
      });
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      const message = 'Open a workspace folder to install prompts.';
      await webview.postMessage({
        command: 'installResult',
        ok: false,
        localId,
        error: message,
      });
      vscode.window.showErrorMessage('Agent Slayer: ' + message);
      return;
    }

    const promptsDir = path.join(folder.uri.fsPath, 'prompts');
    const filePath = path.join(promptsDir, prompt.localId + '.prompt.md');

    try {
      await fs.mkdir(promptsDir, { recursive: true });
      await fs.writeFile(filePath, this.buildPromptMarkdown(prompt), 'utf8');

      await webview.postMessage({
        command: 'installResult',
        ok: true,
        localId,
      });
    } catch (error) {
      const message = 'Failed to install prompt file.';
      log('Marketplace install failed: ' + String(error));
      await webview.postMessage({
        command: 'installResult',
        ok: false,
        localId,
        error: message,
      });
    }
  }

  private buildPromptMarkdown(prompt: UiPrompt): string {
    const tags = prompt.tags.length ? prompt.tags.join(', ') : 'marketplace';

    return [
      '---',
      'name: ' + prompt.name,
      'description: ' + prompt.description,
      'category: ' + prompt.category,
      'author: ' + prompt.author,
      'stars: ' + String(prompt.stars),
      'tags: ' + tags,
      'source: marketplace',
      'id: ' + prompt.id,
      '---',
      prompt.content,
      '',
    ].join('\n');
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Slayer Marketplace</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.4)));
      --accent: var(--vscode-focusBorder);
      --highlight: var(--vscode-textLink-foreground);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --ok: var(--vscode-testing-iconPassed);
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

    .app {
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
      padding: 16px;
    }

    .top {
      display: grid;
      gap: 10px;
    }

    .search-wrap {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel);
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      padding: 8px 10px;
      gap: 8px;
    }

    #search {
      border: 0;
      background: transparent;
      color: var(--text);
      outline: none;
      font-size: 13px;
      width: 100%;
    }

    #search::placeholder {
      color: var(--muted);
    }

    .source {
      font-size: 11px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 360px;
    }

    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .pill {
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      border-radius: 999px;
      font-size: 12px;
      padding: 6px 12px;
      cursor: pointer;
      transition: all 180ms ease;
    }

    .pill:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }

    .pill.active {
      border-color: var(--accent);
      background: var(--vscode-list-activeSelectionBackground, var(--panel));
      color: var(--vscode-list-activeSelectionForeground, var(--text));
    }

    .content {
      position: relative;
      min-height: 0;
      overflow: auto;
      padding-right: 2px;
    }

    .content::-webkit-scrollbar {
      width: 8px;
    }

    .content::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 999px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding-bottom: 10px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      display: grid;
      gap: 8px;
      min-height: 170px;
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
      position: relative;
      overflow: hidden;
    }

    .card:hover {
      transform: translateY(-2px);
      border-color: var(--accent);
      box-shadow: 0 10px 18px rgba(0, 0, 0, 0.25);
    }

    .card.leaving {
      animation: fadeScaleOut 130ms ease forwards;
    }

    .card.enter {
      opacity: 0;
      transform: scale(0.97);
      animation: fadeScaleIn 180ms ease forwards;
    }

    @keyframes fadeScaleOut {
      to {
        opacity: 0;
        transform: scale(0.95);
      }
    }

    @keyframes fadeScaleIn {
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .installed-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      border: 1px solid var(--border);
      color: var(--ok);
      background: var(--panel);
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .name {
      font-size: 14px;
      font-weight: 650;
      padding-right: 92px;
    }

    .meta {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
    }

    .stars {
      color: var(--highlight);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    .desc {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-height: 52px;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 24px;
    }

    .tag {
      font-size: 11px;
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 999px;
      color: var(--text);
      padding: 3px 8px;
    }

    .actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 9px;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      cursor: pointer;
      transition: all 160ms ease;
      min-width: 78px;
      position: relative;
    }

    .btn:hover {
      transform: translateY(-1px);
      background: var(--vscode-button-secondaryHoverBackground);
      border-color: var(--accent);
    }

    .btn.install.loading {
      color: transparent;
      pointer-events: none;
    }

    .btn.install.loading::after {
      content: '';
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(248, 250, 252, 0.3);
      border-top-color: #f8fafc;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      animation: spin 500ms linear infinite;
    }

    @keyframes spin {
      to {
        transform: translate(-50%, -50%) rotate(360deg);
      }
    }

    .btn.install.done {
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      pointer-events: none;
    }

    .skeleton-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .skeleton {
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--panel);
      height: 170px;
      position: relative;
      overflow: hidden;
    }

    .skeleton::after {
      content: '';
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(127, 127, 127, 0.22), transparent);
      animation: shimmer 1200ms ease infinite;
    }

    @keyframes shimmer {
      to {
        transform: translateX(100%);
      }
    }

    .empty {
      min-height: 280px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
      padding: 16px;
    }

    .empty-illu {
      width: 110px;
      height: 110px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--panel);
      display: grid;
      place-items: center;
      margin: 0 auto 12px auto;
      font-size: 38px;
    }

    .hidden {
      display: none;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(6px);
      display: grid;
      place-items: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
      z-index: 10;
      padding: 18px;
    }

    .modal-backdrop.open {
      opacity: 1;
      pointer-events: auto;
    }

    .modal {
      width: min(920px, 100%);
      max-height: 80vh;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--panel);
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
      box-shadow: 0 24px 40px rgba(0, 0, 0, 0.55);
    }

    .modal-head {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }

    .modal-title {
      font-size: 14px;
      font-weight: 700;
    }

    #modal-content {
      margin: 0;
      padding: 14px;
      overflow: auto;
      color: var(--text);
      font-size: 12px;
      line-height: 1.55;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .error {
      border: 1px solid var(--vscode-inputValidation-errorBorder, var(--border));
      background: var(--vscode-inputValidation-errorBackground, var(--panel));
      color: var(--vscode-inputValidation-errorForeground, var(--text));
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 12px;
    }

    @media (max-width: 1024px) {
      .grid,
      .skeleton-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="top">
      <div class="search-wrap">
        <input id="search" type="search" placeholder="Search prompts, tags, authors..." />
        <div id="source" class="source"></div>
      </div>
      <div id="filters" class="filters"></div>
    </section>

    <section id="error-box" class="error hidden"></section>

    <section class="content">
      <div id="skeleton" class="skeleton-grid"></div>
      <div id="grid" class="grid hidden"></div>
      <div id="empty" class="empty hidden">
        <div>
          <div class="empty-illu">⌁</div>
          <div>No prompts match your filters.</div>
        </div>
      </div>
    </section>
  </main>

  <aside id="modal-backdrop" class="modal-backdrop" role="dialog" aria-modal="true">
    <section class="modal">
      <header class="modal-head">
        <div id="modal-title" class="modal-title"></div>
        <button id="close-modal" class="btn" type="button">Close</button>
      </header>
      <pre id="modal-content"></pre>
    </section>
  </aside>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const state = {
      prompts: [],
      filtered: [],
      categories: ['All'],
      installedIds: new Set(),
      activeCategory: 'All',
      search: '',
      sourceUrl: '',
      loading: true,
      renderToken: 0,
    };

    const searchEl = document.getElementById('search');
    const sourceEl = document.getElementById('source');
    const filtersEl = document.getElementById('filters');
    const skeletonEl = document.getElementById('skeleton');
    const gridEl = document.getElementById('grid');
    const emptyEl = document.getElementById('empty');
    const modalBackdrop = document.getElementById('modal-backdrop');
    const modalTitle = document.getElementById('modal-title');
    const modalContent = document.getElementById('modal-content');
    const closeModalBtn = document.getElementById('close-modal');
    const errorBox = document.getElementById('error-box');

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function setLoading(loading) {
      state.loading = loading;
      if (loading) {
        gridEl.classList.add('hidden');
        emptyEl.classList.add('hidden');
        skeletonEl.classList.remove('hidden');
        renderSkeleton();
      } else {
        skeletonEl.classList.add('hidden');
      }
    }

    function renderSkeleton() {
      skeletonEl.innerHTML = '';
      for (let i = 0; i < 6; i += 1) {
        const node = document.createElement('div');
        node.className = 'skeleton';
        skeletonEl.append(node);
      }
    }

    function renderFilters() {
      filtersEl.innerHTML = '';
      state.categories.forEach((category) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pill' + (state.activeCategory === category ? ' active' : '');
        btn.textContent = category;
        btn.addEventListener('click', () => {
          if (state.activeCategory === category) {
            return;
          }

          state.activeCategory = category;
          renderFilters();
          filterAndRender(true);
        });
        filtersEl.append(btn);
      });
    }

    function matches(prompt) {
      const byCategory =
        state.activeCategory === 'All' ||
        prompt.category.toLowerCase() === state.activeCategory.toLowerCase();

      if (!byCategory) {
        return false;
      }

      const needle = state.search.trim().toLowerCase();
      if (!needle) {
        return true;
      }

      const bag = [
        prompt.name,
        prompt.description,
        prompt.author,
        prompt.category,
        ...(Array.isArray(prompt.tags) ? prompt.tags : []),
      ]
        .join(' ')
        .toLowerCase();

      return bag.includes(needle);
    }

    function filterAndRender(withAnimation) {
      state.filtered = state.prompts.filter(matches);
      renderCards(withAnimation);
    }

    function renderCards(withAnimation) {
      if (!state.filtered.length) {
        gridEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        return;
      }

      emptyEl.classList.add('hidden');
      gridEl.classList.remove('hidden');

      const token = ++state.renderToken;
      if (withAnimation && gridEl.children.length > 0) {
        Array.from(gridEl.children).forEach((child) => {
          child.classList.add('leaving');
        });

        window.setTimeout(() => {
          if (token !== state.renderToken) {
            return;
          }

          paintCards(true);
        }, 130);
        return;
      }

      paintCards(false);
    }

    function paintCards(markEnter) {
      gridEl.innerHTML = '';

      state.filtered.forEach((prompt) => {
        const card = document.createElement('article');
        card.className = 'card' + (markEnter ? ' enter' : '');

        const installed = state.installedIds.has(prompt.localId);
        if (installed) {
          const badge = document.createElement('div');
          badge.className = 'installed-badge';
          badge.textContent = '✓ Installed';
          card.append(badge);
        }

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = prompt.name;

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML =
          '<span>@' + escapeHtml(prompt.author) + '</span>' +
          '<span class="stars">★ ' + String(prompt.stars || 0) + '</span>' +
          '<span>' + escapeHtml(prompt.category) + '</span>';

        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = prompt.description;

        const tags = document.createElement('div');
        tags.className = 'tags';
        const rawTags = Array.isArray(prompt.tags) ? prompt.tags : [];
        rawTags.slice(0, 6).forEach((tagText) => {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = String(tagText);
          tags.append(tag);
        });

        const actions = document.createElement('div');
        actions.className = 'actions';

        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'btn preview';
        previewBtn.textContent = 'Preview';
        previewBtn.addEventListener('click', () => {
          openModal(prompt);
        });

        const installBtn = document.createElement('button');
        installBtn.type = 'button';
        installBtn.className = 'btn install' + (installed ? ' done' : '');
        installBtn.textContent = installed ? '✓ Installed' : 'Install';
        installBtn.disabled = installed;
        installBtn.dataset.localId = prompt.localId;
        installBtn.addEventListener('click', () => {
          startInstall(installBtn, prompt.localId);
        });

        actions.append(previewBtn, installBtn);
        card.append(name, meta, desc, tags, actions);
        gridEl.append(card);
      });
    }

    function startInstall(button, localId) {
      if (button.classList.contains('loading') || state.installedIds.has(localId)) {
        return;
      }

      button.classList.add('loading');
      button.disabled = true;
      const start = Date.now();

      const onResult = (event) => {
        const message = event.data;
        if (!message || message.command !== 'installResult' || message.localId !== localId) {
          return;
        }

        window.removeEventListener('message', onResult);
        const elapsed = Date.now() - start;
        const wait = Math.max(0, 500 - elapsed);

        window.setTimeout(() => {
          button.classList.remove('loading');

          if (message.ok) {
            state.installedIds.add(localId);
            button.classList.add('done');
            button.textContent = '✓ Installed';
            paintCards(false);
          } else {
            button.disabled = false;
            button.textContent = 'Install';
            showError(message.error || 'Installation failed.');
          }
        }, wait);
      };

      window.addEventListener('message', onResult);
      vscode.postMessage({ command: 'install', localId });
    }

    function openModal(prompt) {
      modalTitle.textContent = prompt.name;
      modalContent.textContent = prompt.content;
      modalBackdrop.classList.add('open');
    }

    function closeModal() {
      modalBackdrop.classList.remove('open');
    }

    function showError(text) {
      errorBox.textContent = text;
      errorBox.classList.remove('hidden');
    }

    function clearError() {
      errorBox.classList.add('hidden');
      errorBox.textContent = '';
    }

    searchEl.addEventListener('input', () => {
      state.search = searchEl.value;
      filterAndRender(true);
    });

    closeModalBtn.addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (event) => {
      if (event.target === modalBackdrop) {
        closeModal();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.command === 'data' && message.payload) {
        clearError();
        const payload = message.payload;
        state.prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
        const discovered = Array.from(
          new Set(
            state.prompts
              .map((prompt) => String(prompt.category || '').trim())
              .filter(Boolean)
          )
        ).sort((a, b) => a.localeCompare(b));
        state.categories = ['All', ...discovered];
        if (!state.categories.includes(state.activeCategory)) {
          state.activeCategory = 'All';
        }
        state.installedIds = new Set(Array.isArray(payload.installedIds) ? payload.installedIds : []);
        state.sourceUrl = payload.sourceUrl || '';
        sourceEl.textContent = state.sourceUrl;
        setLoading(false);
        renderFilters();
        filterAndRender(false);
      }

      if (message.command === 'error') {
        setLoading(false);
        showError(message.error || 'Unknown marketplace error');
        state.prompts = [];
        filterAndRender(false);
      }
    });

    setLoading(true);
    renderFilters();
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () =>
      chars.charAt(Math.floor(Math.random() * chars.length))
    ).join('');
  }
}