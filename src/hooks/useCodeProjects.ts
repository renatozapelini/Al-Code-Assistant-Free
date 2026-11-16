import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeAssistantRunner, createCodeProject, PROJECT_STORAGE_KEY, restoreCodeProjects,
  validateProjectFiles, validateProjectPath, type CodeProject, type CreateProjectInput } from '../utils/codeAssistant';
import { createAssistantTransport } from '../utils/assistantTransport';
import { buildZipBlob } from '../utils/androidProjectZip';
import { saveProjectZip } from '../utils/androidBridge';

export function useCodeProjects(apiFetch: (path: string, init?: RequestInit) => Promise<Response>) {
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = useRef<CodeProject[]>([]);
  const runner = useRef<CodeAssistantRunner | null>(null);
  const ready = useRef(false);
  const executionBlocked = useRef(new Set<string>());
  const [blockedVersion, setBlockedVersion] = useState(0);
  const setExecutionBlocked = useCallback((id: string, blocked: boolean) => {
    if (executionBlocked.current.has(id) === blocked) return;
    if (blocked) executionBlocked.current.add(id);
    else executionBlocked.current.delete(id);
    setBlockedVersion(value => value + 1);
  }, []);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      const restored = restoreCodeProjects(localStorage.getItem(PROJECT_STORAGE_KEY));
      list.current = restored; setProjects(restored); setActiveId(restored[0]?.id ?? null); ready.current = true;
    } catch (e) { setError(`Não foi possível abrir os checkpoints locais. Nada foi sobrescrito. ${e instanceof Error ? e.message : ''}`); }
    return () => { alive.current = false; runner.current?.pause(); };
  }, []);
  const saveList = useCallback((next: CodeProject[]) => {
    if (!ready.current) throw new Error('Armazenamento local indisponível. Não sobrescreveremos checkpoints existentes.');
    const raw = JSON.stringify(next);
    if (new TextEncoder().encode(raw).length > 4400000) throw new Error('Armazenamento local perto do limite. Exporte o projeto antes de continuar. Nenhum arquivo foi descartado.');
    localStorage.setItem(PROJECT_STORAGE_KEY, raw); // Failure halts the runner.
    list.current = next;
    if (alive.current) setProjects(next);
  }, []);
  const saveProject = useCallback((next: CodeProject) => saveList(list.current.map((p) => p.id === next.id ? next : p)), [saveList]);
  const handleError = useCallback((e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : 'Falha no projeto.'); }, []);
  const create = useCallback((input: CreateProjectInput) => {
    try {
      if (list.current.length >= 10) throw new Error('Limite de 10 projetos locais. Exporte os projetos antes de criar mais.');
      const project = createCodeProject(input);
      saveList([project, ...list.current]); setActiveId(project.id); setError(null);
      return project.id;
    } catch (e) { handleError(e); return null; }
  }, [saveList, handleError]);
  const run = useCallback(async (id: string, automatic = false) => {
    if (runner.current || executionBlocked.current.has(id) || executionBlocked.current.has('*')) return;
    let project = list.current.find((p) => p.id === id);
    if (!project) return;
    if (project.turn >= project.maxTurns) {
      if (automatic || !window.confirm('O orçamento foi atingido. Autorizar mais 40 tentativas de IA para continuar deste checkpoint? Isso pode consumir créditos.')) return;
      project = { ...project, maxTurns: project.maxTurns + 40 }; saveProject(project);
    }
    const nextRunner = new CodeAssistantRunner(project, createAssistantTransport(apiFetch), saveProject);
    runner.current = nextRunner; setBusyId(id); setError(null);
    try { await nextRunner.run(); } catch (e) { handleError(e); }
    finally { runner.current = null; if (alive.current) setBusyId(null); }
  }, [apiFetch, saveProject, handleError]);
  const pause = useCallback((id: string) => {
    if (runner.current?.project.id === id) { runner.current.pause(); return; }
    const project = list.current.find((p) => p.id === id);
    if (project) try { saveProject({ ...project, status: 'paused', updatedAt: Date.now() }); } catch (e) { handleError(e); }
  }, [saveProject, handleError]);
  // Waiting is not success: retry only while the app remains open, respecting the
  // original API-attempt budget. A reload restores a paused checkpoint.
  useEffect(() => {
    if (busyId || executionBlocked.current.has('*')) return;
    const waiting = projects.find((p) => p.status === 'waiting' && p.turn < p.maxTurns && !executionBlocked.current.has(p.id));
    if (!waiting) return;
    const timer = setTimeout(() => void run(waiting.id, true), 60000);
    return () => clearTimeout(timer);
  }, [projects, busyId, run, blockedVersion]);
  const saveFiles = useCallback((id: string, incoming: Record<string, string>) => {
    try {
      if (runner.current) throw new Error('Pause a execução antes de editar arquivos.');
      const project = list.current.find((p) => p.id === id);
      if (!project) return false;
      for (const path of Object.keys(incoming)) validateProjectPath(path);
      const files = { ...project.files, ...incoming }; validateProjectFiles(files);
      // Pending tool arguments are stale after a human edit; don't replay them.
      const next = { ...project, files, revision: project.revision + 1, status: 'paused' as const,
        exchanges: [], pending: undefined, summary: '', updatedAt: Date.now(),
        events: [...project.events, { id: crypto.randomUUID(), at: Date.now(), type: 'edit', message: `Arquivos editados pelo usuário: ${Object.keys(incoming).join(', ')}. Leia a revisão atual antes de continuar.` }].slice(-150) };
      saveProject(next); setError(null); return true;
    } catch (e) { handleError(e); return false; }
  }, [saveProject, handleError]);
  const saveFile = useCallback((id: string, path: string, content: string) => saveFiles(id, { [path]: content }), [saveFiles]);
  const exportProject = useCallback((id: string) => {
    try {
      const project = list.current.find((p) => p.id === id);
      if (!project) return;
      if (!Object.keys(project.files).length) throw new Error('Ainda não há arquivos para exportar.');
      validateProjectFiles(project.files);
      const blob = buildZipBlob(Object.entries(project.files).map(([path, content]) => ({ path, content })));
      const filename = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'projeto'}.zip`;
      void saveProjectZip(blob, filename).catch(handleError);
    } catch (e) { handleError(e); }
  }, [handleError]);
  const requestChange = useCallback((id: string, instruction: string) => {
    try {
      if (runner.current) throw new Error('Pause a execução antes de solicitar uma alteração.');
      if (!instruction.trim() || instruction.length > 10000) throw new Error('Descreva a alteração em até 10.000 caracteres.');
      const project = list.current.find((p) => p.id === id);
      if (!project) return false;
      const goal = `${project.goal}\n\nALTERAÇÃO SOLICITADA PELO USUÁRIO:\n${instruction.trim()}`;
      if (new TextEncoder().encode(goal).length > 30000) throw new Error('Limite de instruções do projeto atingido.');
      saveProject({ ...project, goal, status: 'paused', pending: undefined, exchanges: [], revision: project.revision + 1,
        updatedAt: Date.now(), error: undefined, events: [...project.events, { id: crypto.randomUUID(), at: Date.now(), type: 'request',
          message: `Nova alteração: ${instruction.trim()}. Os arquivos existentes foram preservados.` }].slice(-150) });
      setError(null); return true;
    } catch (e) { handleError(e); return false; }
  }, [saveProject, handleError]);
  const configureProviders = useCallback((id: string, providerIds: string[]) => {
    try {
      if (runner.current) throw new Error('Pause a execução antes de alterar a equipe.');
      if (!Array.isArray(providerIds) || providerIds.length > 100 || providerIds.some(value => typeof value !== 'string' || !value)) throw new Error('Fila inválida.');
      const project = list.current.find(p => p.id === id);
      if (!project) return false;
      saveProject({ ...project, providerIds: [...new Set(providerIds)], status: 'paused', updatedAt: Date.now(),
        events: [...project.events, { id: crypto.randomUUID(), at: Date.now(), type: 'team', message: 'Equipe atualizada pelo usuário. Arquivos e checkpoint preservados.' }].slice(-150) });
      setError(null); return true;
    } catch (e) { handleError(e); return false; }
  }, [saveProject, handleError]);
  const renameProject = useCallback((id: string, rawName: string) => {
    try {
      if (runner.current?.project.id === id) throw new Error('Pause a execução antes de renomear o projeto.');
      const name = rawName.trim();
      if (!name || name.length > 200) throw new Error('Use um nome de 1 a 200 caracteres.');
      const project = list.current.find((p) => p.id === id);
      if (!project) return false;
      if (project.name === name) return true;
      saveProject({ ...project, name, updatedAt: Date.now(),
        events: [...project.events, { id: crypto.randomUUID(), at: Date.now(), type: 'edit', message: `Projeto renomeado para “${name}”.` }].slice(-150) });
      setError(null); return true;
    } catch (e) { handleError(e); return false; }
  }, [saveProject, handleError]);
  const deleteProject = useCallback((id: string) => {
    try {
      if (runner.current?.project.id === id) throw new Error('Pause a execução antes de apagar o projeto.');
      if (!list.current.some((p) => p.id === id)) return false;
      const next = list.current.filter((p) => p.id !== id);
      saveList(next);
      setActiveId((current) => (current === id ? next[0]?.id ?? null : current));
      setError(null); return true;
    } catch (e) { handleError(e); return false; }
  }, [saveList, handleError]);
  const recordBuild = useCallback((id: string, revision: number, result: { ok: boolean; stdout?: string; stderr?: string; script?: string }) => {
    const project = list.current.find((p) => p.id === id);
    if (!project) return;
    try {
      saveProject({ ...project, updatedAt: Date.now(), events: [...project.events, { id: crypto.randomUUID(), at: Date.now(), type: 'build',
        message: `${result.script || 'build'} da revisão ${revision}: ${result.ok ? 'processo terminou com sucesso' : 'falhou'}. ${result.stderr?.slice(-1200) || result.stdout?.slice(-1200) || ''}` }].slice(-150) });
    } catch (e) { handleError(e); }
  }, [saveProject, handleError]);
  return { projects, activeId, busyId, error, create, setExecutionBlocked, select: setActiveId, run, pause, saveFile, saveFiles, exportProject, requestChange, configureProviders, renameProject, deleteProject, recordBuild };
}
