import { useEffect, useState } from 'react';
import type { CodeProject } from '../utils/codeAssistant';

interface Props {
  project: CodeProject;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onResult: (result: { ok: boolean; stdout?: string; stderr?: string; script?: string }) => void;
}
export function ProjectBuildReview({ project, apiFetch, onClose, onResult }: Props) {
  const [prepared, setPrepared] = useState<{ token: string; scripts: Record<string, string>; warning: string; workspace: string } | null>(null);
  const [script, setScript] = useState('');
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consumed, setConsumed] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    void apiFetch('/api/app/project-build/prepare', { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id,
        name: project.name, revision: project.revision, files: project.files }) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || data.stderr || (typeof data.error === 'string' ? data.error : '') || `HTTP ${response.status}`);
        if (!data.token || !data.scripts) throw new Error('Este aplicativo não oferece compilação local de projetos. Exporte os arquivos para uma máquina com a toolchain necessária.');
        setPrepared(data); setScript(Object.keys(data.scripts)[0] || '');
      }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Preparação indisponível.'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [apiFetch, project.id, project.revision]);
  const execute = async () => {
    if (!prepared || !approved || !script || busy || consumed) return;
    setBusy(true); setError(''); setConsumed(true);
    try {
      const response = await apiFetch('/api/app/project-build/run', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: prepared.token, script }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || data.stderr || (typeof data.error === 'string' ? data.error : '') || `HTTP ${response.status}`);
      const result = { ok: data.ok === true, stdout: String(data.stdout || ''), stderr: String(data.stderr || ''), script };
      setOutput(`${result.ok ? 'Processo concluído com sucesso.' : 'Processo falhou.'}\n${result.stdout}\n${result.stderr}\nArquivos no Windows: ${data.workspace || prepared.workspace}`);
      onResult(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Falha na compilação.'); onResult({ ok: false, stderr: String(e), script }); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Revisão de compilação">
    <section className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[#101318] border border-zinc-700 rounded-xl p-5 space-y-4">
      <h2 className="text-lg font-semibold">Compilar / validar: {project.name}</h2>
      <p className="text-xs text-zinc-400">Snapshot da revisão {project.revision}. Preparar os arquivos não executa código nem instala dependências.</p>
      {busy && <p className="text-sm text-zinc-300">{consumed ? 'Executando o script aprovado...' : 'Preparando revisão dos arquivos...'}</p>}
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
      {prepared && <>
        <p className="text-xs text-amber-200 whitespace-pre-wrap">{prepared.warning}</p>
        <label className="block text-xs">Script do package.json
          <select className="block w-full min-h-[44px] mt-2 bg-zinc-900 border border-zinc-700 rounded px-3" value={script}
            disabled={busy || consumed} onChange={(e) => { setScript(e.target.value); setApproved(false); }}>
            {Object.keys(prepared.scripts).map((name) => <option key={name}>{name}</option>)}
          </select>
        </label>
        {!script && <p className="text-xs text-zinc-400">Nenhum script lint, test ou build encontrado. Exporte o projeto e use a toolchain da plataforma correspondente.</p>}
        {script && <pre className="p-3 bg-black/40 rounded text-xs whitespace-pre-wrap break-all">{prepared.scripts[script]}</pre>}
        <label className="flex gap-3 items-start text-xs text-zinc-300 min-h-[44px]">
          <input type="checkbox" className="mt-1" checked={approved} disabled={busy || consumed} onChange={(e) => setApproved(e.target.checked)} />
          Li o script e autorizo sua execução nesta máquina. Código gerado por IA pode acessar arquivos e rede com as minhas permissões.
        </label>
      </>}
      {output && <pre className="text-xs whitespace-pre-wrap break-all p-3 border border-zinc-700 rounded max-h-60 overflow-auto">{output}</pre>}
      <div className="flex gap-3 justify-end">
        <button type="button" className="min-h-[44px] px-4 border border-zinc-700 rounded" disabled={busy && consumed} onClick={onClose}>Fechar</button>
        <button type="button" className="min-h-[44px] px-4 bg-emerald-500 text-zinc-950 rounded font-medium disabled:opacity-40"
          disabled={!prepared || !approved || !script || busy || consumed} onClick={() => void execute()}>Executar script aprovado</button>
      </div>
    </section>
  </div>;
}
