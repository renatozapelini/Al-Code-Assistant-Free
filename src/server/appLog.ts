import fs from 'node:fs';
import path from 'node:path';
import { ensureDesktopDirs, logFile } from './desktopPaths.ts';

// Registro simples em arquivo: quando a janela mostra uma falha, o diagnóstico
// precisa sobreviver ao fechamento do aplicativo (o console do .exe é oculto).
// Nunca grava chaves, tokens ou conteúdo de projeto: só contexto e mensagens.

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_TAIL_LINES = 200;

function timestamp(): string {
  return new Date().toISOString();
}

function safeLine(text: string): string {
  return text.replace(/[\r\n\u0000-\u001f]+/g, ' ').slice(0, 4000);
}

export function appendLog(level: 'info' | 'warn' | 'error', message: string): void {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${timestamp()} ${level.toUpperCase()} ${safeLine(message)}\n`, 'utf8');
  } catch {
    // Um log que falha nunca pode derrubar o aplicativo.
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : 'erro desconhecido';
}

export function logError(context: string, err: unknown): void {
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
  appendLog('error', `${context}: ${errorMessage(err)}${stack}`);
}

/** Últimas linhas do log, para a tela de diagnóstico do aplicativo. */
export function readLogTail(maxLines = MAX_TAIL_LINES): string {
  try {
    const file = logFile();
    if (!fs.existsSync(file)) return '';
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(maxLines, MAX_TAIL_LINES))).join('\n');
  } catch {
    return '';
  }
}

export function prepareLog(): void {
  try {
    ensureDesktopDirs();
    appendLog('info', `aplicativo iniciado (pid ${process.pid})`);
  } catch {
    // ignore
  }
}
