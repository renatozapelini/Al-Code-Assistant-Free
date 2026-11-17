import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Caminhos do aplicativo Windows. Nada aqui é específico da interface: o mesmo
// módulo roda no servidor de desenvolvimento (onde as variáveis de ambiente
// permitem apontar para uma pasta de teste).
//
// - dados (chaves, contas, preferências): pasta do usuário, nunca o diretório
//   de instalação, para uma atualização não apagar nada;
// - projetos: pasta visível em Documentos, para o usuário abrir no Explorer e
//   o envio ao GitHub usar exatamente os mesmos arquivos;
// - logs: pasta local do aplicativo, usada pelo diagnóstico quando algo falha.

export function dataDir(): string {
  return process.env.QD_DATA_DIR ? path.resolve(process.env.QD_DATA_DIR) : path.join(os.homedir(), '.qoder2api-hub');
}

export function projectsDir(): string {
  const override = process.env.CODE_ASSISTANTS_PROJECTS_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), 'Documents', 'Code Assistants', 'Projetos');
}

export function appDir(): string {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Code-Assistants') : path.join(os.homedir(), '.code-assistants');
}

export function logsDir(): string {
  return path.join(appDir(), 'logs');
}

export function logFile(): string {
  return process.env.CODE_ASSISTANTS_LOG_FILE
    ? path.resolve(process.env.CODE_ASSISTANTS_LOG_FILE)
    : path.join(logsDir(), 'app.log');
}

export interface DesktopPaths {
  dataDir: string;
  projectsDir: string;
  logsDir: string;
  logFile: string;
}

export function desktopPaths(): DesktopPaths {
  return { dataDir: dataDir(), projectsDir: projectsDir(), logsDir: logsDir(), logFile: logFile() };
}

/** Cria as pastas na primeira execução e devolve os caminhos já prontos. */
export function ensureDesktopDirs(): DesktopPaths {
  const paths = desktopPaths();
  for (const dir of [paths.dataDir, paths.projectsDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
