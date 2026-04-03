import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config';
import { getPromptsDestPath } from './installPrompts';
import { log } from '../utils/logger';

interface PromptMeta {
  file: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
}

const DEFAULT_FALLBACK_PROMPT = 'debug-and-fix.prompt.md';

function buildConfigContext(config: Config): string {
  return `FE:${config.frontendFramework} Stack:${config.stack} DB:${config.database} MultiTenant:${config.multiTenant} OrgField:${config.orgIdField} Tests:${config.testFramework}`;
}

async function loadPromptFile(fileName: string): Promise<string | null> {
  try {
    const filePath = path.join(getPromptsDestPath(), fileName);
    return await fs.readFile(filePath, 'utf-8');
  } catch { return null; }
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  return raw
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parsePromptFrontmatter(file: string, content: string): PromptMeta {
  const fallbackName = file.replace(/\.prompt\.md$/i, '').replace(/[-_]+/g, ' ');
  const meta: PromptMeta = {
    file,
    name: fallbackName,
    description: '',
    category: 'General',
    tags: [],
  };

  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return meta;

  const lines = match[1].split(/\r?\n/);
  let readingTagsList = false;
  for (const row of lines) {
    const line = row.trim();
    if (!line) continue;

    if (readingTagsList) {
      if (line.startsWith('- ')) {
        meta.tags.push(line.slice(2).trim());
        continue;
      }

      readingTagsList = false;
    }

    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1].toLowerCase();
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '');

    if (key === 'name' && value) meta.name = value;
    if (key === 'description' && value) meta.description = value;
    if (key === 'category' && value) meta.category = value;
    if (key === 'tags') {
      if (!value) {
        meta.tags = [];
        readingTagsList = true;
      } else {
        meta.tags = parseTags(value);
      }
    }
  }

  return meta;
}

async function loadPromptCatalog(): Promise<PromptMeta[]> {
  try {
    const promptsDir = getPromptsDestPath();
    const files = (await fs.readdir(promptsDir)).filter((file) => file.endsWith('.prompt.md'));
    const metas: PromptMeta[] = [];

    for (const file of files) {
      const raw = await loadPromptFile(file);
      if (!raw) continue;
      metas.push(parsePromptFrontmatter(file, raw));
    }

    return metas;
  } catch {
    return [];
  }
}

function detectIntentFromCatalog(message: string, catalog: PromptMeta[]): string | null {
  const messageTokens = new Set(tokenize(message));
  if (!messageTokens.size || !catalog.length) return null;

  let bestFile: string | null = null;
  let bestScore = 0;

  for (const prompt of catalog) {
    const source = [
      prompt.name,
      prompt.description,
      prompt.category,
      prompt.file.replace(/\.prompt\.md$/i, '').replace(/[-_]+/g, ' '),
      ...prompt.tags,
    ].join(' ');

    const promptTokens = new Set(tokenize(source));
    let score = 0;
    for (const token of messageTokens) {
      if (promptTokens.has(token)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestFile = prompt.file;
    }
  }

  if (bestFile) return bestFile;
  const fallback = catalog.find((prompt) => prompt.file === DEFAULT_FALLBACK_PROMPT);
  return fallback ? fallback.file : catalog[0]?.file ?? null;
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  getConfig: () => Config
): void {
  const participant = vscode.chat.createChatParticipant(
    'copilot-skills.assistant',
    async (request, _ctx, stream, token) => {
      const config = getConfig();
      const configCtx = buildConfigContext(config);
      const userMessage = request.prompt.trim();
      const catalog = await loadPromptCatalog();

      if (!userMessage) {
        stream.markdown('What would you like help with? I can route to any installed prompt automatically.');
        return;
      }

      const intentFile = detectIntentFromCatalog(userMessage, catalog);

      if (!intentFile) {
        stream.markdown('No prompt files are installed yet. Run **Agent Slayer: Install Prompt Files** first.');
        return;
      }

      const promptContent = await loadPromptFile(intentFile);

      if (!promptContent) {
        stream.markdown(`Prompt file \`${intentFile}\` not found. Run **Agent Slayer: Install Prompt Files** first.\n\nContext: \`${configCtx}\`\n\nTask: ${userMessage}`);
        log(`Missing prompt file: ${intentFile}`);
        return;
      }

      if (token.isCancellationRequested) return;

      // Strip frontmatter, trim to reduce tokens
      const cleanPrompt = promptContent.replace(/^---[\s\S]*?---\n/, '').trim();
      stream.markdown(`*Config: \`${configCtx}\`*\n\n`);
      stream.markdown(`${cleanPrompt}\n\n---\n\n**Executing for:** ${userMessage}`);
      log(`Chat: intent=${intentFile} message="${userMessage.slice(0, 60)}"`);
    }
  );

  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);
}
