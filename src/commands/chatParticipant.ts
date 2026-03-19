import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config';
import { getPromptsDestPath } from './installPrompts';
import { log } from '../utils/logger';

const INTENT_MAP: Record<string, string> = {
  endpoint:  'new-endpoint.prompt.md',
  route:     'new-endpoint.prompt.md',
  api:       'new-endpoint.prompt.md',
  test:      'write-tests.prompt.md',
  spec:      'write-tests.prompt.md',
  coverage:  'write-tests.prompt.md',
  review:    'security-review.prompt.md',
  security:  'security-review.prompt.md',
  audit:     'security-review.prompt.md',
  migration: 'create-migration.prompt.md',
  schema:    'create-migration.prompt.md',
  alter:     'create-migration.prompt.md',
  feature:   'new-feature.prompt.md',
  build:     'new-feature.prompt.md',
  query:     'db-query.prompt.md',
  select:    'db-query.prompt.md',
  fetch:     'db-query.prompt.md',
};

function detectIntent(message: string): string | null {
  const lower = message.toLowerCase();
  for (const [keyword, file] of Object.entries(INTENT_MAP)) {
    if (lower.includes(keyword)) return file;
  }
  return null;
}

function buildConfigContext(config: Config): string {
  return `FE:${config.frontendFramework} Stack:${config.stack} DB:${config.database} MultiTenant:${config.multiTenant} OrgField:${config.orgIdField} Tests:${config.testFramework}`;
}

async function loadPromptFile(fileName: string): Promise<string | null> {
  try {
    const filePath = path.join(getPromptsDestPath(), fileName);
    return await fs.readFile(filePath, 'utf-8');
  } catch { return null; }
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

      if (!userMessage) {
        stream.markdown('What would you like help with? Try: *create endpoint*, *write tests*, *security review*, *new feature*, *db query*, or *migration*.');
        return;
      }

      const intentFile = detectIntent(userMessage);

      if (!intentFile) {
        stream.markdown(`I can help with:\n- \`/new-endpoint\` — create API routes\n- \`/write-tests\` — generate tests\n- \`/security-review\` — audit code\n- \`/new-feature\` — full feature build\n- \`/db-query\` — safe DB queries\n- \`/create-migration\` — Alembic migrations\n\nWhat are you trying to build?`);
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
