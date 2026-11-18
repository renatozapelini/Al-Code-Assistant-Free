import React from 'react';
import { Code2, Download, LogOut, Menu, User } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { androidBridge } from '../utils/androidBridge';
import type { NavTab } from '../types/hub';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onQuickAddApi: () => void;
  onOpenDrawer?: () => void;
  onOpenAuth?: () => void;
  onLogout?: () => void;
  isAuthenticated?: boolean | null;
  userEmail?: string;
}

const NAV_ITEMS: { id: NavTab; label: string }[] = [
  { id: 'projects', label: 'Projetos' },
  { id: 'chat', label: 'Chat do projeto' },
  { id: 'apis', label: 'APIs IA' },
  { id: 'options', label: 'Opções' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onQuickAddApi,
  onOpenDrawer,
  onOpenAuth,
  onLogout,
  isAuthenticated,
  userEmail,
}) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const primaryActionClass = 'min-h-[40px] min-w-[40px] px-2.5 sm:px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center justify-center gap-1.5 shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300';
  const isAuthenticatedBool = isAuthenticated === true;

  return (
    <header className="sticky top-0 z-30 min-h-14 bg-[#090B0E]/90 backdrop-blur-md border-b border-zinc-800/80 pt-safe">
      <div className="max-w-7xl mx-auto min-h-14 px-3 sm:px-6 py-2 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => onSelectTab('projects')}
          aria-label="Code Assistants — abrir Projetos"
          className="min-h-[40px] min-w-0 max-w-full md:shrink-0 text-base sm:text-lg font-bold tracking-tight text-zinc-100 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-md"
        >
          <Code2 className="w-6 h-6 shrink-0 text-emerald-400" aria-hidden="true" />
          <span className="md:whitespace-nowrap">Code Assistants</span>
        </button>

        <nav className="hidden md:flex flex-1 items-center gap-4 overflow-x-auto min-w-0" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`min-h-[40px] border-b-2 text-sm font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded ${
                  active ? 'text-emerald-400 border-emerald-500' : 'text-zinc-400 hover:text-zinc-100 border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0 max-w-full ml-auto md:shrink-0">
          {isAuthenticatedBool ? (
            <>
              <button
                type="button"
                onClick={onOpenAuth}
                aria-label="Conta"
                className="min-h-[44px] px-3 py-2 rounded-lg border border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-800/50 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                <User className="w-4 h-4" />
                <span className="hidden sm:block">{userEmail || 'Conta'}</span>
              </button>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Sair"
                className="min-h-[44px] px-3 py-2 rounded-lg border border-zinc-800 text-xs text-zinc-400 hover:bg-red-950/40 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:block">Sair</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onOpenAuth}
                aria-label="Entrar"
                className="min-h-[44px] px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                <User className="w-4 h-4 shrink-0" />
                <span className="hidden sm:block">Entrar</span>
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onOpenDrawer}
            aria-label="Abrir menu"
            className="md:hidden min-h-[44px] min-w-[44px] rounded-lg text-zinc-400 flex items-center justify-center focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <Menu className="w-5 h-5" />
          </button>
          {!androidBridge() && isInstallable && !isInstalled && (
            <button type="button" onClick={() => void install()} aria-label="Instalar App" title="Instalar App" className={primaryActionClass}>
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span className="sr-only sm:not-sr-only">Instalar App</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
