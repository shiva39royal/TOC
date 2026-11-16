import React from 'react';
import { Upload } from 'lucide-react';

export type WorkspaceTab = 'schematic' | 'inventory' | 'validation' | 'toc';

interface TopNavProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenUpload: () => void;
}

const NAV_ITEMS: { id: WorkspaceTab; label: string }[] = [
  { id: 'schematic', label: 'Track Schematic' },
  { id: 'inventory', label: 'Extracted Data' },
  { id: 'validation', label: 'Validation' },
  { id: 'toc', label: 'TOC Output' },
];

export const TopNav: React.FC<TopNavProps> = ({
  activeTab,
  onSelectTab,
  onOpenUpload,
}) => {
  return (
    <header className="no-print sticky top-0 z-30 bg-white border-b border-slate-200">
      <div className="max-w-[1440px] mx-auto px-6 h-14 flex items-center justify-between gap-8">
        {/* Brand Title */}
        <button
          type="button"
          onClick={() => onSelectTab('schematic')}
          className="text-lg font-display font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
        >
          SignalTOC
        </button>

        {/* 4 Single-line Navigation Links */}
        <nav className="flex items-center gap-6 overflow-x-auto" aria-label="Workspace sections">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? 'text-blue-700'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-700"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Upload Layout</span>
          </button>
        </div>
      </div>
    </header>
  );
};
