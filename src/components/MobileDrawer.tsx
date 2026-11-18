import React, { useCallback } from 'react';
import {
  Code2,
  FolderCode,
  MessageSquare,
  KeyRound,
  Settings2,
  Monitor,
  X,
} from 'lucide-react';
import type { NavTab } from '../types/hub';
import { isDesktopApp } from '../utils/platform';

interface MobileDrawerProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  isOpen: boolean;
  onClose: () => void;
  online: boolean;
  desktop: boolean;
}

const NAV_ITEMS: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'projects', label: 'Projetos', icon: FolderCode },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'apis', label: 'APIs IA', icon: KeyRound },
  ...(isDesktopApp()
    ? [{ id: 'desktop' as NavTab, label: 'Este computador', icon: Monitor }]
    : []),
  { id: 'options', label: 'Opções', icon: Settings2 },
];

export const MobileDrawer: React.FC<MobileDrawerProps> = ({
  activeTab,
  onSelectTab,
  isOpen,
  onClose,
  online,
  desktop,
}) => {
  if (!isOpen) return null;

  const backdrop = (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    />
  );

  const drawerContent = (
    <div
      className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-full bg-[#0B0E12] border-r border-zinc-800/80 flex flex-col transform transition-transform duration-300 ease-in-out -translate-x-full"
      style={{ transform: 'translateX(0)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => onSelectTab('projects')}
          className="flex items-center gap-2 text-left"
        >
          <Code2 className="w-6 h-6 shrink-0 text-emerald-400" aria-hidden="true" />
          <span className="text-sm font-bold tracking-tight text-zinc-100">Code Assistants</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar menu"
          className="p-2 rounded-md hover:bg-zinc-800/50 text-zinc-400 focus:outline-none"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <nav aria-label="Navegação móvel" className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onClose();
              }}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                active
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100'
              }`}
            >
              <Icon className={`w-5 h-5 shrink-0 ${active ? 'text-emerald-400' : 'text-zinc-500'}`} aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="px-4 py-3 border-t border-zinc-800/80 text-xs text-zinc-500 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span>{online ? 'Conectado' : 'Sem conexão'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-zinc-400">Versão</span>
          <span className="text-zinc-200 font-mono">3.5.11</span>
        </div>
        {desktop && (
          <div className="flex items-center gap-2">
            <span className="text-zinc-400">Modelos locais</span>
            <span className="text-zinc-200 font-mono">Ollama / LM Studio</span>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {backdrop}
      {drawerContent}
    </>
  );
};
