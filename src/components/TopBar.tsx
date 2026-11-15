import React from 'react';
import { BarChart3, Cpu, Download, FileCode2, KeyRound } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import type { NavTab } from '../types/hub';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onQuickAddApi: () => void;
}

const NAV_ITEMS: { id: NavTab; label: string }[] = [
  { id: 'hub', label: 'Hub' },
  { id: 'chat', label: 'Chat' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'apis', label: 'APIs IA' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'accounts', label: 'Contas' },
  { id: 'models', label: 'Modelos' },
  { id: 'android', label: 'Compilar' },
];

export const TopBar: React.FC<TopBarProps> = ({ activeTab, onSelectTab, onQuickAddApi }) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();

  return (
    <header className="sticky top-0 z-30 h-14 bg-[#090B0E]/90 backdrop-blur-md border-b border-zinc-800/80 pt-safe">
      <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4 sm:gap-8">
        <button
          type="button"
          onClick={() => onSelectTab('hub')}
          className="text-base sm:text-lg font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0 flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-md"
        >
          <svg className="w-6 h-6 shrink-0" viewBox="0 0 512 512" fill="none" aria-hidden="true">
            <rect width="512" height="512" rx="112" fill="#12151B" />
            <circle cx="256" cy="256" r="154" stroke="#10B981" strokeWidth="30" />
            <path d="M312 312L398 398" stroke="#34D399" strokeWidth="32" strokeLinecap="round" />
            <circle cx="256" cy="256" r="42" fill="#F4F4F5" />
          </svg>
          <span>Qoder2API Hub</span>
        </button>

        <nav className="hidden md:flex items-center gap-5 lg:gap-6" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-1 text-sm font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded ${
                  active ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {item.label}
                {active && (
                  <span className="absolute left-0 right-0 -bottom-[17px] h-0.5 bg-emerald-500 rounded-full" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onSelectTab('scripts')}
            aria-label="Gerador de Scripts IA"
            className={`md:hidden min-h-[40px] min-w-[40px] px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
              activeTab === 'scripts'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-950/30'
                : 'border-zinc-800 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <FileCode2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('analytics')}
            aria-label="Analytics de Tokens e Falhas"
            className={`md:hidden min-h-[40px] min-w-[40px] px-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
              activeTab === 'analytics'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-950/30'
                : 'border-zinc-800 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onSelectTab('models')}
            aria-label="Catálogo de Modelos"
            className={`md:hidden min-h-[40px] min-w-[40px] px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              activeTab === 'models'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-950/30'
                : 'border-zinc-800 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Modelos</span>
          </button>

          {isInstallable && !isInstalled ? (
            <button
              type="button"
              onClick={() => void install()}
              className="min-h-[40px] px-3.5 sm:px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Instalar App</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onQuickAddApi}
              className="min-h-[40px] px-3.5 sm:px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>+ Chaves IA</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
