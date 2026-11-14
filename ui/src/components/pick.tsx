// A single-choice menu with a label, for forms and toolbars. A thin wrapper over the shadcn/ui Select.
import type { ReactNode } from 'react';
import { cn } from 'cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export interface PickOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function Pick<T extends string>({ value, onChange, options, label, id, className, placeholder, disabled, focusKey, ...aria }: {
  value: T | undefined;
  onChange(value: T): void;
  options: readonly PickOption<T>[];
  /** The accessible name when no visible <label> points at `id`. */
  label?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  focusKey?: string;
  'aria-describedby'?: string;
}) {
  return (
    <Select value={value} onValueChange={next => onChange(next as T)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} data-detail-focus={focusKey} className={cn('w-full', className)} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-[min(22rem,var(--radix-select-content-available-height))]">
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            <span dir="auto">{option.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
