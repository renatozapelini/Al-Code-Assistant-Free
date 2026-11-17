import React, { useCallback, useEffect, useState } from 'react';
import { Code2, FolderCode, MessageSquare, KeyRound, Settings2, Sparkles, Boxes, BarChart3, UserRound, Circle, Monitor, Menu, ChevronLeft } from 'lucide-react';
import type { NavTab } from '../types/hub';
import { APP_VERSION } from '../version';

interface DesktopSidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  online: boolean;
  desktop: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
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
  { id: 'desktop', label: 'Este computador', icon: Monitor },
];

const itemClass = (active: boolean, collapsed: boolean) =>
  `min-h-[40px] w-full flex items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${collapsed ? 'justify-center px-2' : 'justify-start px-3'} ${active ? 'bg-emerald-500/10 text-emerald-300' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100'}`;

export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({ activeTab, onSelectTab, online, desktop, collapsed, onToggleCollapsed }) => {
  return (
    <aside className={`hidden lg:flex lg:flex-col lg:shrink-0 lg:sticky lg:top-0 lg:h-screen border-r border-zinc-800/80 bg-[#0B0E12] px-2 py-3 transition-all duration-300 ${collapsed ? 'lg:w-16' : 'lg:w-64'}`}>
      {/* Cabeçalho com toggle sanduíche */}
      <div className="flex items-center justify-between mb-3 px-1">
        <button type="button" onClick={() => onSelectTab('projects')} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <Code2 className="h-6 w-6 shrink-0 text-emerald-400" aria-hidden="true" />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold tracking-tight">Code Assistants</span>
              <span className="block truncate text-[11px] text-zinc-500">{desktop ? 'aplicativo Windows' : 'no navegador'}</span>
            </span>
          )}
        </button>
        <button type="button" onClick={onToggleCollapsed} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" aria-label={collapsed ? 'Expansão menu' : 'Contrair menu'}>
          {collapsed ? <ChevronLeft className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <nav aria-label="Navegação do aplicativo" className="space-y-1">
        {PRIMARY.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={itemClass(activeTab === item.id, collapsed)}
            >
              <Icon className={`h-4 w-4 shrink-0 ${collapsed ? 'mx-auto' : ''}`} aria-hidden="true" />
              {!collapsed && item.label}
            </button>
          );
        })}
      </nav>

      <p className={`mt-5 mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 ${collapsed ? 'text-center' : ''}`}>Ferramentas</p>
      <nav aria-label="Ferramentas" className="space-y-1">
        {TOOLS.filter((item) => item.id !== 'desktop' || desktop).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={itemClass(activeTab === item.id, collapsed)}
            >
              <Icon className={`h-4 w-4 shrink-0 ${collapsed ? 'mx-auto' : ''}`} aria-hidden="true" />
              {!collapsed && item.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onSelectTab('options')}
          aria-current={activeTab === 'options' ? 'page' : undefined}
          className={itemClass(activeTab === 'options', collapsed)}
        >
          <Settings2 className={`h-4 w-4 shrink-0 ${collapsed ? 'mx-auto' : ''}`} aria-hidden="true" />
          {!collapsed && 'Opções'}
        </button>
      </nav>

      <div className={`mt-auto space-y-2 border-t border-zinc-800/80 pt-3 px-1 ${collapsed ? 'text-center' : ''}`}>
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-500">
          <Circle className={`h-2 w-2 ${online ? 'fill-emerald-400 text-emerald-400' : 'fill-amber-400 text-amber-400'}`} aria-hidden="true" />
          {!collapsed && (online ? 'Conectado' : 'Sem conexão')}
        </p>
        {!collapsed && (
          <>
            <p className="px-1 text-[11px] text-zinc-500">Versão {APP_VERSION}</p>
            <p className="px-1 text-[11px] text-zinc-500 leading-relaxed">Suas chaves e projetos ficam neste computador.</p>
          </>
        )}
      </div>
    </aside>
  );
};
