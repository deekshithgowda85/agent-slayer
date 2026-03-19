import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | null = null;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Agent Slayer');
  }
  return _channel;
}

export function log(message: string): void {
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function disposeChannel(): void {
  _channel?.dispose();
  _channel = null;
}
