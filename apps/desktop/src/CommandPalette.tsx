import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Command } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Something the palette can do. More are added as the app grows. */
export interface PaletteCommand {
  id: string;
  title: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  /** The shortcut that does the same, shown beside the name. */
  keys?: string;
  run(): void;
}

interface Props {
  commands: PaletteCommand[];
  onClose(): void;
}

/** `⌘P`: every command by name, as in Obsidian. */
export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = commands.filter((command) =>
    words.every((word) => command.title.toLowerCase().includes(word)),
  );
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const choose = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  return (
    <div
      className="fixed inset-0 z-20 flex items-start justify-center bg-black/30 pt-[14vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Commands"
        className="border-border bg-popover text-popover-foreground w-[min(600px,90vw)] overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="border-border flex items-center gap-3 border-b px-4">
          <Command size={16} className="text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={query}
            placeholder="Type a command…"
            aria-label="Type a command"
            className="placeholder:text-faint h-12 flex-1 bg-transparent outline-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'Enter') choose(rows[selected]);
              else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setSelected((selected + step + rows.length) % Math.max(rows.length, 1));
              }
            }}
          />
        </div>
        <ul ref={list} className="max-h-[50vh] overflow-auto p-1.5">
          {rows.map((command, position) => (
            <li key={command.id}>
              <button
                data-command={command.id}
                data-selected={position === selected}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm',
                  position === selected && 'bg-accent text-accent-foreground',
                )}
                onMouseEnter={() => setSelected(position)}
                onClick={() => choose(command)}
              >
                <command.icon size={16} className="text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{command.title}</span>
                {command.keys && (
                  <kbd className="text-muted-foreground shrink-0 font-sans text-xs tracking-wide">
                    {command.keys}
                  </kbd>
                )}
              </button>
            </li>
          ))}
          {!rows.length && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              No command matches.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
