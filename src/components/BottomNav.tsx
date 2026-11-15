import React from 'react';
import { Settings2, FolderCode, KeyRound, MessageSquare } from 'lucide-react';
import type { NavTab } from '../types/hub';

interface BottomNavProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  accountsCount?: number;
  providersCount: number;
}

const TABS: { id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'projects', label: 'Projetos', icon: FolderCode },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'apis', label: 'APIs IA', icon: KeyRound },
  { id: 'options', label: 'Opções', icon: Settings2 },
];

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onSelectTab,
  providersCount,
}) => {
  return (
    <nav
      aria-label="Navegação móvel"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#090B0E]/95 backdrop-blur-md border-t border-zinc-800/80 pb-safe"
    >
      <div className="grid grid-cols-4 h-16 items-center">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          const badgeValue = tab.id === 'apis' ? providersCount : 0;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`min-h-[48px] min-w-0 flex flex-col items-center justify-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${
                active ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {badgeValue > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 text-[10px] font-mono tabular-nums text-emerald-400 font-semibold">
                    {badgeValue}
                  </span>
                )}
              </div>
              <span className="text-[11px] font-medium tracking-tight leading-none whitespace-nowrap">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
