// One quiet pill that narrows a question: by source, by collection or by topic. A pill with something chosen
// is tinted sage and says what it is set to; an empty one says only what it narrows by. The list is a small
// combobox, so a long list of topics can be searched with the keyboard.
import { useState, type ReactNode } from 'react';
import { cn } from 'cn';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface NarrowOption {
  /** What is sent. '' is the option that removes the narrowing. */
  value: string;
  label: string;
  hint?: string;
}

export function NarrowMenu({ label, icon, value, shownAs, options, searchable = false, onChange }: {
  /** What the pill narrows by: "Source", "Collection", "Topic". */
  label: string;
  icon: ReactNode;
  value: string;
  /** What to call the chosen value when it is not in the list (a collection that has gone). */
  shownAs?: string;
  options: readonly NarrowOption[];
  searchable?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find(option => option.value === value);
  const text = value ? chosen?.label ?? shownAs ?? value : label;
  const choose = (next: string) => { setOpen(false); onChange(next); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={value ? `Narrowed by ${label.toLowerCase()}: ${text}. Change` : `Narrow by ${label.toLowerCase()}`}
          className={cn(
            'inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full border ps-2.5 pe-2 text-xs font-medium outline-none transition-[border-color,background-color,color] duration-200 coarse:h-11',
            value ? 'border-sage/40 bg-sage-pale text-sage dark:text-sage-deep' : 'border-line bg-card-2/60 text-ink-soft hov:border-line-strong hov:text-ink',
          )}
        >
          <span className="shrink-0 [&_svg]:size-3.5" aria-hidden="true">{icon}</span>
          <span dir="auto" className="min-w-0 truncate">{text}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          {searchable ? <CommandInput placeholder={`Find a ${label.toLowerCase()}…`} aria-label={`Find a ${label.toLowerCase()}`} /> : null}
          <CommandList className="max-h-72">
            <CommandEmpty className="px-3 py-5 text-center text-sm text-ink-soft">Nothing by that name.</CommandEmpty>
            <CommandGroup>
              {options.map(option => (
                <CommandItem key={option.value || '__any'} value={option.value || '__any'} keywords={[option.label]} onSelect={() => choose(option.value)}>
                  <Check className={cn('size-4', option.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint ? <span className="num text-2xs text-ink-soft">{option.hint}</span> : null}
                </CommandItem>
              ))}
              {value && !chosen ? (
                <CommandItem value={value} keywords={[text]} onSelect={() => choose(value)}>
                  <Check className="size-4" aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 truncate">{text}</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
