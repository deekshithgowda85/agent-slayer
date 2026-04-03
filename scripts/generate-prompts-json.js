const fs = require('fs');
const path = require('path');

const root = process.cwd();
const promptsDir = path.join(root, 'prompts');
const outFile = path.join(root, 'prompts.json');

function clean(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toTitle(value) {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parsePrompt(raw) {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) {
    return { metadata: {}, content: raw.trim() };
  }

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }

    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      metadata[key] = value;
    }
  }

  return {
    metadata,
    content: raw.slice(match[0].length).trim(),
  };
}

function buildPromptObject(fileName, raw) {
  const base = fileName.replace(/\.prompt\.md$/i, '');
  const parsed = parsePrompt(raw);
  const firstLine = parsed.content.split(/\r?\n/).find((line) => line.trim());

  return {
    id: clean(parsed.metadata.id, base),
    name: clean(parsed.metadata.name, toTitle(base)),
    description: clean(parsed.metadata.description, clean(firstLine, 'No description available.')).slice(0, 140),
    category: clean(parsed.metadata.category, 'General'),
    author: clean(parsed.metadata.author, 'deekshithgowda85'),
    stars: Number.parseInt(clean(parsed.metadata.stars, '0'), 10) || 0,
    tags: clean(parsed.metadata.tags, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^['\"]|['\"]$/g, ''))
      .filter(Boolean),
    content: clean(parsed.content, 'You are a helpful assistant.'),
  };
}

function main() {
  if (!fs.existsSync(promptsDir)) {
    throw new Error('prompts directory not found');
  }

  const files = fs
    .readdirSync(promptsDir)
    .filter((file) => file.endsWith('.prompt.md'))
    .sort((a, b) => a.localeCompare(b));

  const prompts = files.map((fileName) => {
    const fullPath = path.join(promptsDir, fileName);
    const raw = fs.readFileSync(fullPath, 'utf8');
    return buildPromptObject(fileName, raw);
  });

  fs.writeFileSync(outFile, JSON.stringify(prompts, null, 2) + '\n', 'utf8');
  console.log('Generated prompts.json with', prompts.length, 'prompts');
}

main();
