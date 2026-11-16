import React from 'react';
import { Code2, FolderCode, MessageSquare, KeyRound, Settings2, Sparkles, Boxes, BarChart3, UserRound, Circle } from 'lucide-react';
import type { NavTab } from '../types/hub';
import { APP_VERSION } from '../version';

interface DesktopSidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  online: boolean;
  desktop: boolean;
}

const PRIMARY: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'projects', label: 'Projetos', icon: FolderCode },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'apis', label: 'APIs IA', icon: KeyRound },
];

const TOOLS: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'scripts', label: 'Pré-prompt', icon: Sparkles },
  { id: 'models', label: 'Modelos', icon: Boxes },
  { id: 'analytics', label: 'Uso e falhas', icon: BarChart3 },
  { id: 'accounts', label: 'Contas Qoder', icon: UserRound },
];

const itemClass = (active: boolean) =>
  `min-h-[40px] w-full flex items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
    active ? 'bg-emerald-500/10 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100'
  }`;

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({ activeTab, onSelectTab, online, desktop }) => (
  <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen border-r border-zinc-800/80 bg-[#0B0E12] px-3 py-4">
    <button type="button" onClick={() => onSelectTab('projects')} className="mb-5 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
      <Code2 className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold tracking-tight">Code Assistants</span>
        <span className="block truncate text-[11px] text-zinc-500">{desktop ? 'aplicativo Windows' : 'no navegador'}</span>
      </span>
    </button>

    <nav aria-label="Navegação do aplicativo" className="space-y-1">
      {PRIMARY.map((item) => {
        const Icon = item.icon;
        return <button key={item.id} type="button" onClick={() => onSelectTab(item.id)} aria-current={activeTab === item.id ? 'page' : undefined} className={itemClass(activeTab === item.id)}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
        </button>;
      })}
    </nav>

    <p className="mt-5 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Ferramentas</p>
    <nav aria-label="Ferramentas" className="space-y-1">
      {TOOLS.map((item) => {
        const Icon = item.icon;
        return <button key={item.id} type="button" onClick={() => onSelectTab(item.id)} aria-current={activeTab === item.id ? 'page' : undefined} className={itemClass(activeTab === item.id)}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{item.label}
        </button>;
      })}
      <button type="button" onClick={() => onSelectTab('options')} aria-current={activeTab === 'options' ? 'page' : undefined} className={itemClass(activeTab === 'options')}>
        <Settings2 className="h-4 w-4 shrink-0" aria-hidden="true" />Opções
      </button>
    </nav>

    <div className="mt-auto space-y-2 border-t border-zinc-800/80 pt-3 text-[11px] text-zinc-500">
      <p className="flex items-center gap-1.5 px-1"><Circle className={`h-2 w-2 ${online ? 'fill-emerald-400 text-emerald-400' : 'fill-amber-400 text-amber-400'}`} aria-hidden="true" />{online ? 'Conectado' : 'Sem conexão'}</p>
      <p className="px-1">Versão {APP_VERSION}</p>
      <p className="px-1 leading-relaxed">Suas chaves e projetos ficam neste computador.</p>
    </div>
  </aside>
);
