import fs from 'node:fs';
import path from 'node:path';
import { appendLog, errorMessage } from './appLog.ts';
import { projectsDir } from './desktopPaths.ts';

// Cada projeto vive em uma pasta de verdade dentro de "Documentos/Code
// Assistants/Projetos": os arquivos ficam legíveis no Explorer e o envio ao
// GitHub usa exatamente o que está no disco. O checkpoint completo da IA fica
// em project.json, que nunca é enviado a lugar nenhum.

const FILE_LIMIT = 400;
const FILE_BYTES = 200_000;
const TOTAL_BYTES = 2_000_000;
const PROJECT_JSON_BYTES = 8_000_000;
const FORBIDDEN_SEGMENTS = new Set(['.', '..', '.git', 'node_modules', '__proto__', 'prototype', 'constructor']);

export class ProjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStorageError';
  }
}

export function validateProjectFilePaths(files: Record<string, string>): string[] {
  const entries = Object.entries(files);
  if (entries.length > FILE_LIMIT) throw new ProjectStorageError(`Um projeto pode ter no máximo ${FILE_LIMIT} arquivos.`);
  const seen = new Set<string>();
  let total = 0;
  for (const [filePath, content] of entries) {
    if (typeof content !== 'string') throw new ProjectStorageError(`Arquivo inválido: ${filePath}`);
    validateRelativePath(filePath);
    if (seen.has(filePath.toLowerCase())) throw new ProjectStorageError(`Caminhos duplicados (Windows ignora maiúsculas/minúsculas): ${filePath}`);
    seen.add(filePath.toLowerCase());
    const size = Buffer.byteLength(content, 'utf8');
    if (size > FILE_BYTES) throw new ProjectStorageError(`Arquivo maior que 200 KB: ${filePath}`);
    total += size;
  }
  if (total > TOTAL_BYTES) throw new ProjectStorageError('Projeto excede 2 MB de arquivos de texto.');
  return seen.size ? [...Object.keys(files)] : [];
}

export function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240) throw new ProjectStorageError('Caminho de arquivo inválido.');
  if (value !== value.trim() || /[\\:\u0000-\u001f]/.test(value) || value.startsWith('/') || value.includes('//')) {
    throw new ProjectStorageError('Use um caminho relativo seguro, com barras /.');
  }
  for (const segment of value.split('/')) {
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())
      || /[<>"|?*]|[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
      || /^\.env(?:$|\.(?!example$|sample$))/i.test(segment)
      || /^(credentials|secrets|signing-key)\.(json|pem|key)$/i.test(segment)) {
      throw new ProjectStorageError(`Caminho não permitido: ${value}`);
    }
  }
  return value;
}

function resolveInside(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  const check = path.relative(root, target);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new ProjectStorageError(`Caminho fora da pasta do projeto: ${relative}`);
  return target;
}

export function projectFolderName(name: string, id: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase() || 'projeto';
  return `${slug}-${id.slice(0, 8)}`;
}

export interface DesktopProjectSummary {
  id: string;
  name: string;
  folder: string;
  updatedAt: number;
  files: number;
  status?: string;
}

interface StoredProject {
  version: 1;
  savedAt: number;
  project: Record<string, unknown>;
}

function folderPath(name: string, id: string): string {
  return path.join(projectsDir(), projectFolderName(name, id));
}

function findProjectFolder(id: string): string | null {
  const root = projectsDir();
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const meta = path.join(dir, 'project.json');
    if (!fs.existsSync(meta)) continue;
    try {
      const stored = JSON.parse(fs.readFileSync(meta, 'utf8')) as StoredProject;
      if (stored?.project?.id === id) return dir;
    } catch {
      // pasta sem metadado legível: ignorada, nunca apagada
    }
  }
  return null;
}

function writeIfChanged(target: string, content: string): void {
  try {
    if (fs.readFileSync(target, 'utf8') === content) return;
  } catch {
    // arquivo novo
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function removeStaleFiles(dir: string, keep: Set<string>): void {
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const relative = path.relative(dir, abs).replace(/\\/g, '/');
      if (relative === 'project.json') continue;
      if (entry.isDirectory()) {
        walk(abs);
        if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
      } else if (!keep.has(relative)) {
        fs.rmSync(abs, { force: true });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
}

export interface SaveResult extends DesktopProjectSummary {
  path: string;
}

/** Grava o checkpoint e os arquivos do projeto na pasta do computador. */
export function saveProjectToDisk(input: unknown): SaveResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectStorageError('Projeto inválido.');
  const project = input as Record<string, unknown>;
  const id = typeof project.id === 'string' ? project.id : '';
  const name = typeof project.name === 'string' ? project.name.trim() : '';
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw new ProjectStorageError('Identificador de projeto inválido.');
  if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new ProjectStorageError('Nome do projeto inválido.');
  const files = (project.files ?? {}) as Record<string, string>;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new ProjectStorageError('Arquivos do projeto inválidos.');
  const keep = new Set(validateProjectFilePaths(files));

  const root = projectsDir();
  fs.mkdirSync(root, { recursive: true });
  const desired = folderPath(name, id);
  const existing = findProjectFolder(id);
  if (existing && path.resolve(existing) !== path.resolve(desired)) {
    if (fs.existsSync(desired)) throw new ProjectStorageError('Já existe uma pasta com esse nome de projeto.');
    fs.renameSync(existing, desired);
  }
  const dir = fs.existsSync(desired) ? desired : existing ?? desired;
  fs.mkdirSync(dir, { recursive: true });

  for (const [relative, content] of Object.entries(files)) writeIfChanged(resolveInside(dir, relative), content);
  removeStaleFiles(dir, keep);

  const meta: StoredProject = { version: 1, savedAt: Date.now(), project };
  const serialized = JSON.stringify(meta, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > PROJECT_JSON_BYTES) {
    throw new ProjectStorageError('Checkpoint do projeto grande demais para a pasta local; exporte o ZIP.');
  }
  const metaPath = path.join(dir, 'project.json');
  const tmp = `${metaPath}.tmp`;
  fs.writeFileSync(tmp, serialized, 'utf8');
  fs.renameSync(tmp, metaPath);

  const updatedAt = typeof project.updatedAt === 'number' ? project.updatedAt : Date.now();
  return { id, name, folder: path.basename(dir), path: dir, updatedAt, files: keep.size,
    status: typeof project.status === 'string' ? project.status : undefined };
}

export function listProjectsOnDisk(): DesktopProjectSummary[] {
  const root = projectsDir();
  if (!fs.existsSync(root)) return [];
  const result: DesktopProjectSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as StoredProject;
      const project = stored?.project;
      const id = typeof project?.id === 'string' ? project.id : '';
      const name = typeof project?.name === 'string' ? project.name : '';
      if (!id || !name) continue;
      const files = project.files && typeof project.files === 'object' ? Object.keys(project.files).length : 0;
      result.push({ id, name, folder: entry.name,
        updatedAt: typeof project.updatedAt === 'number' ? project.updatedAt : stored.savedAt || 0,
        files, status: typeof project.status === 'string' ? project.status : undefined });
    } catch (err) {
      appendLog('warn', `pasta de projeto ignorada (${entry.name}): ${errorMessage(err)}`);
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readProjectFromDisk(id: string): { project: Record<string, unknown>; path: string } | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw new ProjectStorageError('Identificador de projeto inválido.');
  const dir = findProjectFolder(id);
  if (!dir) return null;
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as StoredProject;
  if (!stored?.project || typeof stored.project !== 'object') throw new ProjectStorageError('Checkpoint local ilegível.');
  return { project: stored.project, path: dir };
}

export function deleteProjectFromDisk(id: string): boolean {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) throw new ProjectStorageError('Identificador de projeto inválido.');
  const dir = findProjectFolder(id);
  if (!dir) return false;
  // Só apaga pastas criadas por este aplicativo (com project.json).
  if (!fs.existsSync(path.join(dir, 'project.json'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
