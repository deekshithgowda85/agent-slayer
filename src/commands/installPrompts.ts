import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { log } from '../utils/logger';

export interface InstallResult {
  installed: string[];
  skipped: string[];
  errors: string[];
}

export function getPromptsDestPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || os.homedir(), 'Code', 'User', 'prompts');
  } else if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'prompts');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'prompts');
}

async function fileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

export async function installPromptFiles(extensionPath: string): Promise<InstallResult> {
  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const src = path.join(extensionPath, 'prompts');
  const dest = getPromptsDestPath();

  try {
    await fs.mkdir(dest, { recursive: true });
    const files = await fs.readdir(src);

    for (const file of files) {
      if (!file.endsWith('.prompt.md')) continue;
      const srcFile = path.join(src, file);
      const destFile = path.join(dest, file);
      try {
        let exists = false;
        try { await fs.access(destFile); exists = true; } catch {}

        if (exists) {
          const [srcHash, destHash] = await Promise.all([fileHash(srcFile), fileHash(destFile)]);
          if (srcHash === destHash) { result.skipped.push(file); log(`Skipped (identical): ${file}`); continue; }
          const destStat = await fs.stat(destFile);
          const srcStat = await fs.stat(srcFile);
          if (destStat.mtime > srcStat.mtime) { result.skipped.push(file); log(`Skipped (user-modified): ${file}`); continue; }
        }

        await fs.copyFile(srcFile, destFile);
        result.installed.push(file);
        log(`Installed: ${file} → ${destFile}`);
      } catch (err) {
        result.errors.push(file);
        log(`Error installing ${file}: ${err}`);
      }
    }
  } catch (err) {
    log(`Fatal install error: ${err}`);
    vscode.window.showErrorMessage(`Agent Slayer: Could not install prompts — ${err}`);
  }

  return result;
}

export async function getInstalledPrompts(): Promise<string[]> {
  try {
    const files = await fs.readdir(getPromptsDestPath());
    return files.filter(f => f.endsWith('.prompt.md'));
  } catch { return []; }
}

export async function uninstallPrompts(extensionPath: string): Promise<void> {
  const src = path.join(extensionPath, 'prompts');
  const dest = getPromptsDestPath();
  try {
    const files = await fs.readdir(src);
    for (const file of files) {
      try { await fs.unlink(path.join(dest, file)); log(`Removed: ${file}`); } catch {}
    }
  } catch (err) { log(`Uninstall error: ${err}`); }
}
