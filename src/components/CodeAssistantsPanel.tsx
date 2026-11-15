import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  Download,
  Eye,
  FileCode2,
  FolderOpen,
  Pause,
  Play,
  Plus,
  Save,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { NavTab, SafeProviderSummary } from '../types/hub';
import type { CodeProject, CreateProjectInput } from '../utils/codeAssistant';

export interface CodeAssistantsPanelProps {
  projects: CodeProject[];
  activeId: string | null;
  busyId: string | null;
  providers: SafeProviderSummary[];
  error: string | null;
  prefill?: string;
  onConsumePrefill: () => void;
  onCreate: (input: CreateProjectInput) => string | null;
  view?: 'home' | 'chat';
  onConfigureProviders?: (id: string, providerIds: string[]) => boolean;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onPause: (id: string) => void;
  onSaveFile: (id: string, path: string, content: string) => boolean;
  onExecutionBlocked?: (id: string, blocked: boolean) => void;
  onImportFiles: (id: string, files: Record<string, string>) => void;
  onRequestChange: (id: string, instruction: string) => boolean;
  onExport: (id: string) => void;
  onBuild: (id: string) => void;
  nativeAndroid?: boolean;
  onNavigate: (tab: NavTab) => void;
}

const cardClass = 'rounded-2xl border border-zinc-800/80 bg-[#12151B] p-4 space-y-3';
const buttonClass = 'min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-[#090B0E] px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const primaryClass = 'min-h-[44px] inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-xs font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300';
const inputClass = 'w-full min-h-[44px] rounded-xl border border-zinc-800 bg-[#090B0E] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50';

const statusInfo: Record<CodeProject['status'], { label: string; explanation: string; color: string }> = {
  idle: { label: 'Pronto para iniciar', explanation: 'O projeto ainda não está em execução. Iniciar autoriza chamadas às APIs selecionadas e alterações nos arquivos do projeto local.', color: 'text-zinc-300' },
  running: { label: 'Em execução', explanation: 'A IA está trabalhando nos arquivos. Edição, importação e compilação ficam bloqueadas até a execução parar.', color: 'text-emerald-300' },
  paused: { label: 'Pausado', explanation: 'O checkpoint foi preservado. Retome para continuar das tarefas e dos arquivos salvos.', color: 'text-amber-300' },
  waiting: { label: 'Aguardando', explanation: 'Há trabalho pendente ou uma API indisponível. Consulte os eventos para entender a espera e a passagem para outra IA.', color: 'text-amber-300' },
  review: { label: 'Aguardando sua validação', explanation: 'A IA encerrou o trabalho, mas isso NÃO significa que o projeto foi testado ou aprovado. Revise os arquivos e valide a compilação antes de usar.', color: 'text-sky-300' },
};

const taskLabels = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluída pela IA' };
const eventLabels: Record<string, string> = {
  handoff: 'Passagem para outra IA',
  failover: 'Troca por indisponibilidade',
  file: 'Arquivo',
  file_saved: 'Arquivo salvo',
  task: 'Tarefa',
  turn: 'Rodada',
  started: 'Execução iniciada',
  paused: 'Pausa',
  waiting: 'Espera',
  review: 'Revisão do usuário',
  completed: 'Trabalho encerrado pela IA',
  error: 'Erro',
};

const MAX_IMPORT_FILES = 200;
const MAX_FILE_BYTES = 200000;
const MAX_IMPORT_BYTES = 2000000;
const PREVIEW_LIMIT = 200_000;
const textExtension = /\.(?:[cm]?[jt]sx?|jsonc?|html?|css|scss|sass|less|vue|svelte|txt|mdx?|ya?ml|toml|xml|svg|csv|sql|py|rs|go|java|kt|kts|c|h|cpp|hpp|cs|php|rb|sh|ps1|bat|cmd|ini|cfg|conf|properties|gradle|graphql|gql|lock)$/i;

function formatDate(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? 'Data indisponível' : date.toLocaleString('pt-BR');
}

function importPath(file: File): string {
  const relative = file.webkitRelativePath || file.name;
  // A pasta escolhida é a raiz do projeto, não parte do caminho de cada arquivo.
  const path = file.webkitRelativePath ? relative.split('/').slice(1).join('/') : relative;
  const segments = path.split('/');
  if (!path || path.length > 240 || /[\\\u0000-\u001f<>:"|?*]/.test(path) || segments.some((part) =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(?:__proto__|prototype|constructor)$/i.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  )) {
    throw new Error(`Caminho relativo inseguro: ${relative}`);
  }
  if (segments.some((part) => /^(?:\.git|node_modules|dist|build|\.win-build)$/i.test(part))) {
    throw new Error(`Selecione apenas fontes, sem dependências ou artefatos: ${path}`);
  }
  const basename = segments[segments.length - 1];
  if (/^(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets?(?:\.|$)|id_rsa|id_ed25519)/i.test(basename)) {
    throw new Error(`Arquivo potencialmente secreto não importado: ${path}`);
  }
  if (!textExtension.test(basename) && !/^(?:Dockerfile|Makefile|\.gitignore|\.gitattributes|\.editorconfig|LICENSE)$/i.test(basename)) {
    throw new Error(`Formato não reconhecido como texto de projeto: ${path}`);
  }
  return path;
}

interface TextFileImportProps {
  disabled: boolean;
  onFiles: (files: Record<string, string>) => void;
  onReading: (reading: boolean) => void;
}

function TextFileImport({ disabled, onFiles, onReading }: TextFileImportProps) {
  const filesInput = useRef<HTMLInputElement>(null);
  const directoryInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const disabledRef = useRef(disabled);
  const readingRef = useRef(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (readingRef.current) onReading(false);
    };
  }, []);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);

  const readFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = '';
    if (disabled || readingRef.current || !selected.length) return;
    readingRef.current = true;
    setReading(true);
    setNotice(null);
    onReading(true);
    try {
      if (selected.length > MAX_IMPORT_FILES || selected.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES) {
        throw new Error('Importe até 200 arquivos e 2 MB por seleção. Nenhum arquivo desta seleção foi importado.');
      }
      const entries: [string, string][] = [];
      const paths = new Set<string>();
      for (const file of selected) {
        const path = importPath(file);
        const normalized = path.toLowerCase();
        if (paths.has(normalized)) throw new Error(`Caminho duplicado para Windows: ${path}`);
        paths.add(normalized);
        if (file.size > MAX_FILE_BYTES) throw new Error(`Arquivo maior que 200 KB: ${path}`);
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        } catch {
          throw new Error(`Não é texto UTF-8 válido: ${path}`);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
          throw new Error(`Conteúdo binário ou caracteres de controle: ${path}`);
        }
        if (!mounted.current) return;
        entries.push([path, content]);
      }
      if (!mounted.current) return;
      if (disabledRef.current) throw new Error('A importação foi cancelada porque o projeto ficou bloqueado.');
      // O callback principal ainda deve validar todos os caminhos antes de salvar.
      onFiles(Object.fromEntries(entries));
    } catch (err) {
      if (mounted.current) setNotice(err instanceof Error ? err.message : 'Falha ao ler arquivos.');
    } finally {
      readingRef.current = false;
      if (mounted.current) {
        setReading(false);
        onReading(false);
      }
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={disabled || reading} onClick={() => filesInput.current?.click()} className={buttonClass}>
          <FileCode2 className="h-4 w-4" aria-hidden="true" /> Importar arquivos de texto
        </button>
        <button type="button" disabled={disabled || reading} onClick={() => directoryInput.current?.click()} className={buttonClass}>
          <FolderOpen className="h-4 w-4" aria-hidden="true" /> Selecionar pasta de fontes
        </button>
      </div>
      <input ref={filesInput} type="file" multiple className="hidden" aria-label="Importar arquivos de texto" onChange={(event) => void readFiles(event)} disabled={disabled || reading} />
      <input ref={directoryInput} type="file" multiple {...{ webkitdirectory: '' }} className="hidden" aria-label="Selecionar pasta de fontes" onChange={(event) => void readFiles(event)} disabled={disabled || reading} />
      <p className="text-[11px] text-zinc-400">
        {reading ? 'Lendo a seleção… ' : ''}Somente texto UTF-8: até 200 KB por arquivo, 200 arquivos / 2 MB por seleção. A pasta escolhida é a raiz do projeto; subpastas são preservadas. Não inclua dependências, artefatos ou segredos. Sem executar código ou pedir acesso ao sistema de arquivos. Os caminhos também são validados ao salvar.
      </p>
      {notice && <p role="alert" className="break-words text-xs text-amber-300">{notice}</p>}
    </div>
  );
}

interface WorkspaceProps {
  project: CodeProject;
  busyId: string | null;
  providers: SafeProviderSummary[];
  onRun: CodeAssistantsPanelProps['onRun'];
  onPause: CodeAssistantsPanelProps['onPause'];
  onSaveFile: CodeAssistantsPanelProps['onSaveFile'];
  onImportFiles: CodeAssistantsPanelProps['onImportFiles'];
  onRequestChange: CodeAssistantsPanelProps['onRequestChange'];
  onExport: CodeAssistantsPanelProps['onExport'];
  onBuild: CodeAssistantsPanelProps['onBuild'];
  nativeAndroid?: boolean;
  onSelectionBlocked: (blocked: boolean) => void;
  onExecutionBlocked?: CodeAssistantsPanelProps['onExecutionBlocked'];
  onConfigureProviders?: CodeAssistantsPanelProps['onConfigureProviders'];
  visible?: boolean;
}

function ProjectWorkspace({ project, busyId, providers, onRun, onPause, onSaveFile, onImportFiles, onRequestChange, onExport, onBuild, nativeAndroid, onSelectionBlocked, onExecutionBlocked, onConfigureProviders, visible = true }: WorkspaceProps) {
  const paths = useMemo(() => Object.keys(project.files).sort(), [project.files]);
  const [selectedPath, setSelectedPath] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { base: string; content: string }>>({});
  const [showPreview, setShowPreview] = useState(false);
  const [changeInstruction, setChangeInstruction] = useState('');
  const [workspaceTab, setWorkspaceTab] = useState<'chat' | 'files' | 'tasks' | 'team'>('chat');
  const [importReading, setImportReading] = useState(false);
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const path = paths.includes(selectedPath) ? selectedPath : paths[0] || '';
  const savedContent = path ? project.files[path] : '';
  const draft = path ? drafts[path] : undefined;
  const content = draft?.content ?? savedContent;
  const dirty = content !== savedContent;
  const conflict = dirty && draft?.base !== savedContent;
  const dirtyPaths = Object.keys(drafts).filter((filePath) => drafts[filePath].content !== project.files[filePath]);
  const engineLocked = busyId === project.id || project.status === 'running';
  const locked = engineLocked || importReading;
  const info = statusInfo[project.status];
  const currentProvider = providers.find((provider) => provider.id === project.activeProviderId);
  const hasAvailableProvider = providers.some((provider) => provider.enabled && project.providerIds.includes(provider.id));
  const budgetReached = project.turn >= project.maxTurns;
  const canPause = project.status === 'running' || project.status === 'waiting';
  const isHtml = /\.html?$/i.test(path);
  const previewTooLarge = content.length > PREVIEW_LIMIT;
  const previewSource = showPreview && isHtml && !previewTooLarge
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none';">${content}`
    : '';

  const draftBlocked = dirtyPaths.length > 0 || importReading || changeInstruction.length > 0;
  useEffect(() => {
    onSelectionBlocked(draftBlocked);
    onExecutionBlocked?.(project.id, draftBlocked);
    return () => onExecutionBlocked?.(project.id, false);
  }, [draftBlocked, project.id, onSelectionBlocked, onExecutionBlocked]);

  const importIntoProject = (files: Record<string, string>) => {
    setImportError(null);
    if (engineLocked || dirtyPaths.length) {
      setImportError('Pare a execução e salve suas edições antes de importar.');
      return;
    }
    const existingPaths = new Map(paths.map((filePath) => [filePath.toLowerCase(), filePath]));
    for (const filePath of Object.keys(files)) {
      const existing = existingPaths.get(filePath.toLowerCase());
      if (existing && (existing !== filePath || !allowOverwrite)) {
        setImportError(`Já existe: ${existing}. Para substituir, autorize abaixo e use exatamente o mesmo caminho. Nenhum arquivo desta seleção foi enviado.`);
        return;
      }
    }
    onImportFiles(project.id, files); // One atomic checkpoint, never a partial batch import.
    setAllowOverwrite(false);
  };

  return (
    <div hidden={!visible} className="min-w-0 space-y-4">
      <section className={cardClass} aria-label="Execução do projeto">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="break-words text-lg font-semibold text-zinc-100">{project.name}</h2>
            <p className="text-xs text-zinc-400">Chat e arquivos desta pasta · {currentProvider?.name || 'Escolha a equipe de APIs'}</p>
          </div>
          <span className={`text-xs font-semibold ${info.color}`} role="status">{info.label}</span>
        </div>
        <p className={`text-xs leading-relaxed ${info.color}`}>{info.explanation}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyId !== null || locked || draftBlocked || !hasAvailableProvider}
            onClick={() => onRun(project.id)}
            className={primaryClass}
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            {project.status === 'idle' ? 'Iniciar assistentes' : project.status === 'review' ? 'Continuar com IA' : 'Retomar trabalho'}
          </button>
          <button type="button" disabled={!canPause} onClick={() => onPause(project.id)} className={buttonClass}>
            <Pause className="h-4 w-4" aria-hidden="true" /> Pausar
          </button>
          <button hidden={workspaceTab !== 'files'} type="button" disabled={locked || !paths.length || dirtyPaths.length > 0} onClick={() => onExport(project.id)} className={buttonClass}>
            <Download className="h-4 w-4" aria-hidden="true" /> Exportar projeto (ZIP)
          </button>
          <button hidden={workspaceTab !== 'files'} type="button" disabled={busyId !== null || locked || !paths.length || dirtyPaths.length > 0} onClick={() => onBuild(project.id)} className={buttonClass}>
            <Terminal className="h-4 w-4" aria-hidden="true" /> {nativeAndroid ? 'Exportar para compilação' : 'Compilar / validar (Windows)'}
          </button>
        </div>
        <details className="text-[11px] text-zinc-400"><summary className="cursor-pointer py-2">Limites e segurança</summary><p>{nativeAndroid ? 'Mantenha o app aberto durante a execução. As APIs recebem o contexto deste projeto e podem consumir saldo. Arquivos e checkpoints ficam locais. O APK não inclui compiladores de projetos: exporte para validar no ambiente adequado. Não importe segredos.' : 'As APIs recebem o contexto do projeto e podem consumir saldo. Compilação exige aprovação humana. Não importe segredos.'}</p></details>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
          <span>Rodadas: <strong className="font-mono text-zinc-200">{project.turn} / {project.maxTurns}</strong></span>
          <span>Revisão: {project.revision}</span>
          <span>Checkpoint: {formatDate(project.updatedAt)}</span>
        </div>
        {dirtyPaths.length > 0 && <p role="status" className="text-xs text-amber-300">{dirtyPaths.length} arquivo(s) com edição não salva. Salve ou recarregue antes de executar, importar, exportar ou compilar.</p>}
        {changeInstruction.length > 0 && <p role="status" className="text-xs text-amber-300">Há um pedido ainda não enviado. Envie o pedido ou limpe o texto antes de executar ou trocar de projeto.</p>}
        {budgetReached && <p className="text-xs text-amber-300">Orçamento de tentativas esgotado. Retomar pedirá sua autorização para mais 40 tentativas, preservando este checkpoint.</p>}
        {!hasAvailableProvider && <p className="text-xs text-amber-300">Nenhuma API habilitada desta equipe está disponível. Confira as APIs salvas antes de retomar.</p>}
        {busyId !== null && busyId !== project.id && <p className="text-xs text-amber-300">Outro projeto está ocupado. Aguarde ou pause sua execução antes de iniciar ou compilar este.</p>}
        {project.error && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-red-300">{project.error}</p>}
      </section>
      <nav className="grid grid-cols-4 gap-1 border-b border-zinc-800" aria-label="Áreas do projeto">
        {([{ id: 'chat', label: 'Chat' }, { id: 'files', label: 'Arquivos' }, { id: 'tasks', label: 'Tarefas' }, { id: 'team', label: 'Equipe' }] as const).map(tab => <button key={tab.id} type="button" aria-pressed={workspaceTab === tab.id} onClick={() => setWorkspaceTab(tab.id)} className={`min-h-[44px] text-xs border-b-2 ${workspaceTab === tab.id ? 'border-emerald-500 text-emerald-300' : 'border-transparent text-zinc-400'}`}>{tab.label}</button>)}
      </nav>
      <div hidden={workspaceTab !== 'chat'} className="space-y-3" aria-label="Chat do projeto">
        <section className={cardClass}>
          <h3 className="text-xs font-semibold text-emerald-300">Você · ideia inicial</h3>
          <p className="whitespace-pre-wrap text-sm text-zinc-200">{project.goal}</p>
          {project.blueprint && <details><summary className="min-h-[44px] py-3 cursor-pointer text-xs text-zinc-400">Pré-prompt do projeto</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-zinc-300">{project.blueprint}</pre></details>}
        </section>
        <section className={cardClass} aria-label="Histórico do chat e ações">
          <p className="text-[11px] text-zinc-500">Histórico real do executor: pedidos, ações e passagem entre IAs.</p>
          {project.events.length ? <ol className="space-y-3 max-h-[420px] overflow-y-auto">
            {project.events.map(event => <li key={event.id} className="border-b border-zinc-800 pb-2">
              <p className="text-[11px] text-emerald-300">{event.type === 'request' ? 'Você' : providers.find(p => p.id === event.providerId)?.name || eventLabels[event.type] || 'Sistema'} · {formatDate(event.at)}</p>
              <p className="text-xs whitespace-pre-wrap text-zinc-300 mt-1">{event.message}</p>
            </li>)}
          </ol> : <p className="text-xs text-zinc-400">Projeto salvo. Marque a equipe na aba Equipe e use o único botão Iniciar assistentes para a IA trabalhar nos arquivos.</p>}
          {project.summary && <p className="whitespace-pre-wrap text-sm text-zinc-200 border-t border-zinc-800 pt-3">{project.summary}</p>}
        </section>
      <section className={cardClass} aria-label="Solicitar alteração no projeto">
        <h3 className="text-sm font-semibold">Continuar / pedir uma alteração</h3>
        <textarea aria-label="Nova alteração para as code assistants" rows={3} maxLength={10000} value={changeInstruction}
          disabled={locked || busyId !== null} onChange={(event) => setChangeInstruction(event.target.value)}
          placeholder="Descreva o que deve mudar neste projeto, sem perder os arquivos existentes." className={inputClass} />
        <button type="button" className={buttonClass} disabled={locked || busyId !== null || dirtyPaths.length > 0 || !changeInstruction.trim()}
          onClick={() => { if (onRequestChange(project.id, changeInstruction)) setChangeInstruction(''); }}>Enviar pedido ao projeto</button>
        <p className="text-[11px] text-zinc-400">Enviar salva no contexto desta pasta. Clique em Retomar para executar; os arquivos anteriores são preservados.</p>
      </section>
      </div>
      <section hidden={workspaceTab !== 'team'} className={cardClass} aria-label="Equipe de assistentes">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100"><Bot className="h-4 w-4 text-emerald-400" aria-hidden="true" /> Assistente atual e passagem de trabalho</h3>
        <div className="rounded-xl border border-zinc-800 bg-[#090B0E] p-3 text-xs">
          <p className="break-words font-medium text-zinc-200">{currentProvider?.name || (project.activeProviderId ? 'API não encontrada nas configurações salvas' : 'Nenhum assistente ativo neste checkpoint')}</p>
          <p className="mt-1 break-words font-mono text-zinc-400">Modelo configurado: {currentProvider?.defaultModel || '—'}</p>
        </div>
        <fieldset disabled={locked || busyId !== null} className="space-y-2">
          <legend className="text-xs text-zinc-400 pb-2">Marque as APIs na ordem em que devem trabalhar</legend>
          {providers.map(provider => {
            const selected = project.providerIds.includes(provider.id);
            return <label key={provider.id} className={`flex gap-2 items-center min-h-[44px] text-xs ${!provider.enabled && !selected ? 'opacity-50' : ''}`}>
              <input type="checkbox" checked={selected} disabled={!provider.enabled && !selected} onChange={e => {
                const next = e.target.checked ? [...project.providerIds, provider.id] : project.providerIds.filter(id => id !== provider.id);
                onConfigureProviders?.(project.id, next);
              }} className="accent-emerald-500" />
              <span>{selected ? `${project.providerIds.indexOf(provider.id) + 1}. ` : ''}{provider.name} · {provider.defaultModel}{!provider.enabled ? ' · desabilitada' : ''}</span>
            </label>;
          })}
          {!providers.length && <p className="text-xs text-amber-300">Adicione suas chaves na aba APIs IA. Depois selecione a equipe aqui.</p>}
          <p className="text-[11px] text-zinc-400">A equipe é salva imediatamente ao marcar ou desmarcar. Depois use apenas o botão Iniciar assistentes.</p>
        </fieldset>
        <ol className="space-y-1.5" aria-label="Ordem de passagem entre APIs">
          {project.providerIds.map((id, index) => {
            const provider = providers.find((item) => item.id === id);
            return (
              <li key={id} className={`rounded-lg border px-3 py-2 text-xs ${id === project.activeProviderId ? 'border-emerald-700/60 bg-emerald-950/20 text-emerald-300' : 'border-zinc-800 text-zinc-400'}`}>
                <span className="mr-2 font-mono">{index + 1}.</span>
                <span className="break-words">{provider?.name || 'API removida / indisponível'} · {provider?.defaultModel || id}{provider && !provider.enabled ? ' · Desabilitada' : ''}</span>
              </li>
            );
          })}
        </ol>
        <p className="text-[11px] leading-relaxed text-zinc-400">As APIs selecionadas editam os arquivos do projeto e recebem o checkpoint ao assumir o trabalho. As trocas automáticas e seus motivos aparecem nos eventos abaixo; não são sessões nativas de Codex, Claude Code ou Cursor.</p>
      </section>

      <section hidden={workspaceTab !== 'tasks'} className={cardClass} aria-label="Tarefas do projeto">
        <h3 className="text-sm font-semibold text-zinc-100">Tarefas · {project.tasks.filter((task) => task.status === 'completed').length} / {project.tasks.length}</h3>
        {project.tasks.length ? (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {project.tasks.map((task) => (
              <li key={task.id} className="flex items-start justify-between gap-3 rounded-xl border border-zinc-800 bg-[#090B0E] p-3 text-xs">
                <span className="whitespace-pre-wrap break-words text-zinc-200">{task.title}</span>
                <span className={`shrink-0 ${task.status === 'completed' ? 'text-emerald-300' : task.status === 'in_progress' ? 'text-amber-300' : 'text-zinc-400'}`}>{taskLabels[task.status]}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-xs text-zinc-400">Ainda não há tarefas registradas pela IA.</p>}
      </section>

      <section hidden={workspaceTab !== 'files'} className={cardClass} aria-label="Editor de arquivos do projeto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">Arquivos do projeto ({paths.length})</h3>
          <span className="text-[11px] text-zinc-400">{locked ? 'Edição bloqueada enquanto ocupado' : 'Edição manual disponível'}</span>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[180px_minmax(0,1fr)]">
          <nav className="max-h-64 space-y-1 overflow-auto rounded-xl border border-zinc-800 bg-[#090B0E] p-1 xl:max-h-[480px]" aria-label="Selecionar arquivo">
            {paths.length ? paths.map((filePath) => (
              <button key={filePath} type="button" onClick={() => { setSelectedPath(filePath); setShowPreview(false); }} aria-current={path === filePath ? 'true' : undefined} className={`min-h-[44px] w-full break-all rounded-lg px-2 py-2 text-left font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${path === filePath ? 'bg-emerald-950/30 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-900'}`}>
                {filePath}{dirtyPaths.includes(filePath) ? ' • não salvo' : ''}
              </button>
            )) : <p className="p-3 text-xs text-zinc-500">Os arquivos aparecerão após importar fontes ou executar os assistentes.</p>}
          </nav>
          {path && (
            <div className="min-w-0 space-y-2">
              <label htmlFor="code-file-editor" className="block break-all font-mono text-xs text-zinc-300">{path}</label>
              <textarea
                id="code-file-editor"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                readOnly={locked}
                aria-describedby="code-file-editor-status"
                value={content}
                onChange={(event) => {
                  if (locked) return;
                  const nextContent = event.target.value;
                  setDrafts((previous) => ({ ...previous, [path]: { base: dirty ? previous[path]?.base ?? savedContent : savedContent, content: nextContent } }));
                }}
                className="min-h-[320px] w-full resize-y rounded-xl border border-zinc-800 bg-[#090B0E] p-3 font-mono text-xs leading-relaxed text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 read-only:text-zinc-400"
              />
              <p id="code-file-editor-status" className="text-[11px] text-zinc-400">{dirty ? 'Edição local ainda não salva no projeto.' : 'Conteúdo salvo no checkpoint.'} {locked ? 'Pause e aguarde a liberação para editar.' : ''}</p>
              {conflict && <p role="alert" className="text-xs text-amber-300">O arquivo salvo mudou depois que você começou a editar. Copie sua edição para preservá-la e recarregue o checkpoint antes de salvar.</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={locked || !dirty || conflict} onClick={() => {
                  if (onSaveFile(project.id, path, content)) setDrafts(previous => {
                    const next = { ...previous }; delete next[path]; return next;
                  });
                }} className={primaryClass}>
                  <Save className="h-4 w-4" aria-hidden="true" /> Salvar arquivo
                </button>
                <button type="button" disabled={locked || !dirty} onClick={() => setDrafts(previous => { const next = { ...previous }; delete next[path]; return next; })} className={buttonClass}>Recarregar versão salva</button>
                {isHtml && !nativeAndroid && <button type="button" onClick={() => setShowPreview((value) => !value)} aria-pressed={showPreview} className={buttonClass}><Eye className="h-4 w-4" aria-hidden="true" /> {showPreview ? 'Ocultar prévia' : 'Prévia HTML passiva'}</button>}
              </div>
              {nativeAndroid && isHtml && <p className="text-[11px] text-zinc-400">Para visualizar a página, exporte o ZIP e abra em um ambiente adequado. O APK não executa HTML gerado dentro da interface que acessa suas chaves.</p>}
              {showPreview && isHtml && !nativeAndroid && (
                <div className="space-y-2">
                  <p className="text-[11px] text-amber-300">Prévia passiva limitada a 200.000 caracteres: sem scripts, acesso à origem, formulários ou recursos externos. Arquivos CSS e imagens do projeto não são resolvidos aqui. Não substitui testes.</p>
                  {previewTooLarge ? <p className="text-xs text-zinc-400">Arquivo grande demais para esta prévia. Exporte para validar no ambiente adequado.</p> : <iframe title={`Prévia passiva de ${path}`} sandbox="" srcDoc={previewSource} referrerPolicy="no-referrer" className="h-80 w-full rounded-xl border border-zinc-800 bg-white" />}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          <TextFileImport disabled={engineLocked || dirtyPaths.length > 0} onReading={setImportReading} onFiles={importIntoProject} />
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" checked={allowOverwrite} disabled={locked || dirtyPaths.length > 0} onChange={(event) => setAllowOverwrite(event.target.checked)} className="h-4 w-4 accent-emerald-500" />
            Autorizar substituição de arquivos com o mesmo caminho nesta importação
          </label>
          {importError && <p role="alert" className="break-words text-xs text-amber-300">{importError}</p>}
        </div>
      </section>

      <section hidden={workspaceTab !== 'team'} className={cardClass} aria-label="Eventos e passagens de trabalho">
        <h3 className="text-sm font-semibold text-zinc-100">Eventos e handoffs ({project.events.length})</h3>
        <p className="text-[11px] text-zinc-400">Mais recentes primeiro. Este histórico mostra ações e motivos enviados pelo executor, sem progresso simulado.</p>
        {project.events.length ? (
          <ol className="max-h-80 space-y-2 overflow-y-auto">
            {[...project.events].reverse().map((event) => (
              <li key={event.id} className="space-y-1 rounded-xl border border-zinc-800 bg-[#090B0E] p-3">
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                  <time dateTime={Number.isNaN(new Date(event.at).getTime()) ? undefined : new Date(event.at).toISOString()}>{formatDate(event.at)}</time>
                  <span className={event.type === 'error' ? 'text-red-300' : 'text-emerald-300'}>{eventLabels[event.type] || event.type}</span>
                  {event.providerId && <span>{providers.find((provider) => provider.id === event.providerId)?.name || event.providerId}</span>}
                </div>
                <p className="whitespace-pre-wrap break-words text-xs text-zinc-200">{event.message}</p>
              </li>
            ))}
          </ol>
        ) : <p className="text-xs text-zinc-400">Nenhum evento registrado. Inicie o projeto para acompanhar ações nos arquivos e passagens entre IAs.</p>}
      </section>
    </div>
  );
}

export const CodeAssistantsPanel: React.FC<CodeAssistantsPanelProps> = ({
  projects, activeId, busyId, providers, error, prefill, onConsumePrefill,
  onCreate, onSelect, onRun, onPause, onSaveFile, onImportFiles, onRequestChange, onExport, onBuild, nativeAndroid, onNavigate, view = 'home', onConfigureProviders, onExecutionBlocked,
}) => {
  const [showCreate, setShowCreate] = useState(Boolean(prefill));
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [blueprint, setBlueprint] = useState('');
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [maxTurns, setMaxTurns] = useState('40');
  const [initialFiles, setInitialFiles] = useState<Record<string, string>>({});
  const [importReading, setImportReading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [workspaceBlocked, setWorkspaceBlocked] = useState(false);
  const consumedPrefill = useRef<string | null>(null);
  const previousProjectCount = useRef(projects.length);
  useEffect(() => {
    onExecutionBlocked?.('*', importReading);
    return () => onExecutionBlocked?.('*', false);
  }, [importReading, onExecutionBlocked]);
  useEffect(() => {
    // Collapse only after the saved project appears; failed creation keeps the draft visible.
    if (projects.length > previousProjectCount.current) setShowCreate(false);
    previousProjectCount.current = projects.length;
  }, [projects.length]);
  const project = projects.find((item) => item.id === activeId);
  const orderedProviders = useMemo(() => [...providers].sort((a, b) => a.priority - b.priority), [providers]);
  const validSelection = providerIds.every((id) => providers.some((provider) => provider.id === id && provider.enabled));
  const validBudget = Number.isSafeInteger(Number(maxTurns)) && Number(maxTurns) > 0 && Number(maxTurns) <= 120;

  useEffect(() => {
    if (!prefill) { consumedPrefill.current = null; return; }
    if (consumedPrefill.current === prefill) return;
    consumedPrefill.current = prefill;
    setBlueprint((previous) => previous.trim() && previous !== prefill ? `${previous}\n\n${prefill}` : prefill);
    setShowCreate(true);
    onConsumePrefill();
  }, [prefill, onConsumePrefill]);

  const moveProvider = (index: number, direction: -1 | 1) => {
    setProviderIds((previous) => {
      const next = [...previous];
      const target = index + direction;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const importInitialFiles = (files: Record<string, string>) => {
    const existing = new Set(Object.keys(initialFiles).map((path) => path.toLowerCase()));
    const duplicate = Object.keys(files).find((path) => existing.has(path.toLowerCase()));
    if (duplicate) { setFormError(`O rascunho já contém ${duplicate}; a importação não substitui arquivos.`); return; }
    const merged = { ...initialFiles, ...files };
    const totalBytes = Object.values(merged).reduce((sum, content) => sum + new TextEncoder().encode(content).length, 0);
    if (Object.keys(merged).length > MAX_IMPORT_FILES || totalBytes > MAX_IMPORT_BYTES) {
      setFormError('O rascunho aceita até 200 arquivos e 2 MB de texto no total.');
      return;
    }
    setInitialFiles(merged);
    setFormError(null);
  };

  const createProject = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (importReading || busyId !== null || workspaceBlocked) return;
    if (!name.trim() || !goal.trim()) { setFormError('Preencha o nome e o objetivo do projeto.'); return; }
    if (!validSelection) { setFormError('Remova da equipe as APIs indisponíveis ou selecione apenas APIs salvas e habilitadas.'); return; }
    if (!validBudget) { setFormError('O orçamento deve ser um número inteiro positivo de rodadas.'); return; }
    const id = onCreate({ name: name.trim(), goal: goal.trim(), blueprint: blueprint.trim() || undefined, providerIds: [...providerIds], files: { ...initialFiles }, maxTurns: Number(maxTurns) });
    if (id) {
      setName(''); setGoal(''); setBlueprint(''); setInitialFiles({}); setShowCreate(false);
    }
    // Failed persistence keeps the complete draft visible.
  };

  return (
    <div className="space-y-4 text-zinc-100">
      <section hidden={view !== 'home'} className="space-y-3">
        <h1 className="text-xl font-bold">Meus projetos</h1>
        <p className="text-xs text-zinc-400">Cada projeto tem seu chat, arquivos e equipe de IAs.</p>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={importReading || workspaceBlocked} onClick={() => setShowCreate(value => !value)} aria-expanded={showCreate} aria-controls="code-create-form" className={primaryClass}><Plus className="h-4 w-4 shrink-0" />{showCreate ? 'Fechar formulário' : 'Novo projeto'}</button>
          <button type="button" onClick={() => onNavigate('scripts')} className={buttonClass}><FileCode2 className="h-4 w-4 shrink-0" />Criar pré-prompt</button>
        </div>
      </section>
      {view === 'chat' && <button type="button" className={buttonClass} onClick={() => onNavigate('projects')}><FolderOpen className="w-4 h-4" /> Todos os projetos</button>}
      {error && <div role="alert" className="rounded-xl border border-red-800/60 bg-red-950/30 p-3 text-xs whitespace-pre-wrap break-words text-red-300">{error}</div>}

      {showCreate && (
        <form hidden={view !== 'home'} id="code-create-form" onSubmit={createProject} className={cardClass}>
          <h2 className="text-sm font-semibold">Novo projeto de código</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-zinc-300"><span>Nome do projeto</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Controle de estoque" className={inputClass} /></label>
            <details className="text-xs text-zinc-400"><summary className="min-h-[44px] py-3 cursor-pointer">Limite de execução · {maxTurns} rodadas</summary><label className="space-y-1"><span>Orçamento máximo de rodadas</span><input type="number" min={1} max={120} step={1} required value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} className={inputClass} /><span className="block text-[11px]">Padrão: 40. Não é um limite de tokens ou custo.</span></label></details>
          </div>
          <label className="block space-y-1 text-xs text-zinc-300"><span>Objetivo e critérios de aceite</span><textarea required rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="O que precisa ser construído, restrições e como você vai validar?" className={inputClass} /></label>
          <details open={Boolean(blueprint)} className="text-xs text-zinc-400"><summary className="min-h-[44px] py-3 cursor-pointer">Pré-prompt / instruções técnicas (opcional)</summary><label className="block space-y-1"><span>Blueprint do projeto</span><textarea rows={4} value={blueprint} onChange={(event) => setBlueprint(event.target.value)} placeholder="Cole um pré-prompt ou gere a partir das suas ideias." className={`${inputClass} font-mono text-xs`} /></label></details>
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-zinc-200">Equipe de APIs (opcional agora)</legend>
            <p className="text-[11px] text-zinc-400">Marque na ordem desejada ou escolha depois no chat, em Equipe.</p>
            {orderedProviders.length ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {orderedProviders.map((provider) => {
                const index = providerIds.indexOf(provider.id);
                return <label key={provider.id} className={`flex min-h-[44px] items-center gap-3 rounded-xl border p-3 text-xs ${index >= 0 ? 'border-emerald-700/60 bg-emerald-950/20' : 'border-zinc-800 bg-[#090B0E]'} ${!provider.enabled && index < 0 ? 'opacity-50' : 'cursor-pointer'}`}>
                  <input type="checkbox" checked={index >= 0} disabled={!provider.enabled && index < 0} onChange={(event) => setProviderIds((previous) => event.target.checked ? [...previous, provider.id] : previous.filter((id) => id !== provider.id))} className="h-4 w-4 shrink-0 accent-emerald-500" />
                  <span className="min-w-0"><span className="block break-words text-zinc-200">{index >= 0 ? `${index + 1}. ` : ''}{provider.name}{!provider.enabled ? ' · Desabilitada' : ''}</span><span className="block break-words font-mono text-[11px] text-zinc-400">{provider.defaultModel}</span></span>
                </label>;
              })}
            </div> : <p className="text-xs text-amber-300">Você pode criar a pasta agora e adicionar a equipe depois, na aba APIs IA.</p>}
            {providerIds.length > 0 && <ol className="space-y-2" aria-label="Ordem dos assistentes selecionados">
              {providerIds.map((id, index) => {
                const provider = providers.find((item) => item.id === id);
                return <li key={id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-[#090B0E] px-3 py-2">
                  <span className={`min-w-0 break-words text-xs ${provider?.enabled ? 'text-zinc-200' : 'text-amber-300'}`}>{index + 1}. {provider?.name || 'API não encontrada'} · {provider?.defaultModel || id}</span>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" disabled={index === 0} onClick={() => moveProvider(index, -1)} aria-label={`Mover ${provider?.name || id} para cima`} className={`${buttonClass} min-w-[44px] px-2`}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" disabled={index === providerIds.length - 1} onClick={() => moveProvider(index, 1)} aria-label={`Mover ${provider?.name || id} para baixo`} className={`${buttonClass} min-w-[44px] px-2`}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
                    {!provider && <button type="button" onClick={() => setProviderIds((previous) => previous.filter((item) => item !== id))} className={buttonClass}>Desmarcar indisponível</button>}
                  </div>
                </li>;
              })}
            </ol>}
            {providerIds.length === 1 && <p className="text-[11px] text-amber-300">Uma API pode trabalhar sozinha. Selecione duas ou mais para passar o trabalho a outra IA.</p>}
          </fieldset>
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <TextFileImport disabled={busyId !== null} onReading={setImportReading} onFiles={importInitialFiles} />
            {Object.keys(initialFiles).length > 0 && <details className="rounded-xl border border-zinc-800 bg-[#090B0E] px-3"><summary className="min-h-[44px] cursor-pointer py-3 text-xs text-zinc-300">{Object.keys(initialFiles).length} arquivo(s) no rascunho</summary><ul className="max-h-40 overflow-auto pb-3 font-mono text-[11px] text-zinc-400">{Object.keys(initialFiles).sort().map((path) => <li key={path} className="break-all">{path}</li>)}</ul></details>}
          </div>
          {formError && <p role="alert" className="break-words text-xs text-amber-300">{formError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={importReading || busyId !== null || workspaceBlocked || !validSelection || !validBudget || !name.trim() || !goal.trim()} className={primaryClass}><Check className="h-4 w-4" aria-hidden="true" /> Criar projeto</button>
            <p className="text-[11px] text-zinc-400">Criar não executa chamadas. Revise a equipe e clique em Iniciar no projeto.</p>
          </div>
        </form>
      )}

      <div className="min-w-0 space-y-4">
        <aside hidden={view !== 'home'} className={cardClass} aria-label="Projetos salvos">
          <h2 className="text-sm font-semibold">Projetos locais ({projects.length})</h2>
          {workspaceBlocked && <p role="status" className="text-[11px] text-amber-300">Salve ou limpe os rascunhos de arquivos e o pedido, e aguarde a importação antes de trocar ou criar um projeto.</p>}
          <nav className="max-h-[480px] space-y-2 overflow-y-auto" aria-label="Selecionar projeto">
            {projects.map((item) => <button key={item.id} type="button" disabled={importReading || (workspaceBlocked && activeId !== item.id)} onClick={() => { if (!importReading && (!workspaceBlocked || activeId === item.id)) onSelect(item.id); }} aria-current={activeId === item.id ? 'true' : undefined} className={`min-h-[44px] w-full space-y-1 rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${activeId === item.id ? 'border-emerald-700/60 bg-emerald-950/25' : 'border-zinc-800 bg-[#090B0E] hover:bg-zinc-900'}`}>
              <span className="block break-words text-xs font-semibold text-zinc-100">{item.name}</span>
              <span className={`block text-[11px] ${statusInfo[item.status].color}`}>{statusInfo[item.status].label}{busyId === item.id ? ' · Ocupado' : ''}</span>
              <span className="block text-[11px] text-zinc-400">{Object.keys(item.files).length} arquivos · {item.turn}/{item.maxTurns} rodadas</span>
            </button>)}
            {!projects.length && <p className="text-xs text-zinc-400">Nenhum projeto salvo. Preencha o formulário para começar.</p>}
          </nav>
        </aside>
        {project ? <ProjectWorkspace key={project.id} project={project} busyId={busyId} providers={providers} onRun={onRun} onPause={onPause} onSaveFile={onSaveFile} onImportFiles={onImportFiles} onRequestChange={onRequestChange} onExport={onExport} onBuild={onBuild} nativeAndroid={nativeAndroid} onSelectionBlocked={setWorkspaceBlocked} onExecutionBlocked={onExecutionBlocked} visible={view === 'home'} onConfigureProviders={onConfigureProviders} /> : null}
      </div>
    </div>
  );
};
