import * as vscode from 'vscode';

export interface Config {
  frontendFramework: 'none' | 'react' | 'nextjs' | 'vue' | 'angular';
  stack: 'fastapi' | 'django' | 'flask' | 'nodejs';
  database: 'postgresql' | 'mysql' | 'mongodb' | 'sqlite';
  multiTenant: boolean;
  autoInstallOnStartup: boolean;
  orgIdField: string;
  testFramework: 'pytest' | 'jest' | 'unittest';
  cicd: string[];
  strictErrorFormat: boolean;
}

const NEW_PREFIX = 'agentSlayer';
const OLD_PREFIX = 'copilotSkills';

const MIGRATION_KEYS = [
  'frontendFramework',
  'stack',
  'database',
  'cicd',
  'multiTenant',
  'strictErrorFormat',
  'autoInstallOnStartup',
  'orgIdField',
  'testFramework',
] as const;

type MigrationKey = (typeof MIGRATION_KEYS)[number];

let _cached: Config | null = null;

function fullKey(prefix: string, key: MigrationKey): string {
  return `${prefix}.${key}`;
}

type InspectLike<T> = {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
} | undefined;

function isUnsetAtAllScopes<T>(inspected: InspectLike<T>): boolean {
  if (!inspected) return true;
  return (
    inspected.globalValue === undefined &&
    inspected.workspaceValue === undefined &&
    inspected.workspaceFolderValue === undefined
  );
}

function hasAnyValueAtAnyScope<T>(inspected: InspectLike<T>): boolean {
  if (!inspected) return false;
  return (
    inspected.globalValue !== undefined ||
    inspected.workspaceValue !== undefined ||
    inspected.workspaceFolderValue !== undefined
  );
}

/**
 * One-time migration helper: if a user has legacy `copilotSkills.*` values but
 * no `agentSlayer.*` values yet, copy them over.
 */
export async function migrateLegacyConfig(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();

  for (const key of MIGRATION_KEYS) {
    const newKey = fullKey(NEW_PREFIX, key);
    const oldKey = fullKey(OLD_PREFIX, key);

    const newInspected = cfg.inspect<unknown>(newKey);
    const oldInspected = cfg.inspect<unknown>(oldKey);

    // Only migrate if the new key is completely unset AND the old key has a value.
    if (!isUnsetAtAllScopes(newInspected) || !hasAnyValueAtAnyScope(oldInspected)) continue;

    // Prefer global value; fall back to workspace/workspaceFolder.
    const legacyValue =
      oldInspected?.globalValue ??
      oldInspected?.workspaceValue ??
      oldInspected?.workspaceFolderValue;

    if (legacyValue === undefined) continue;

    await cfg.update(newKey, legacyValue, vscode.ConfigurationTarget.Global);
  }
}

export function getConfig(): Config {
  if (_cached) return _cached;
  const c = vscode.workspace.getConfiguration(NEW_PREFIX);
  _cached = {
    frontendFramework:    c.get<Config['frontendFramework']>('frontendFramework', 'none'),
    stack:                c.get<Config['stack']>('stack', 'fastapi'),
    database:             c.get<Config['database']>('database', 'postgresql'),
    multiTenant:          c.get<boolean>('multiTenant', true),
    autoInstallOnStartup: c.get<boolean>('autoInstallOnStartup', true),
    orgIdField:           c.get<string>('orgIdField', 'org_id'),
    testFramework:        c.get<Config['testFramework']>('testFramework', 'pytest'),
    cicd:                 c.get<string[]>('cicd', ['github']),
    strictErrorFormat:    c.get<boolean>('strictErrorFormat', true),
  };
  return _cached;
}

export function onConfigChange(callback: (config: Config) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(NEW_PREFIX) || e.affectsConfiguration(OLD_PREFIX)) {
      _cached = null;
      callback(getConfig());
    }
  });
}

export function clearConfigCache(): void {
  _cached = null;
}
