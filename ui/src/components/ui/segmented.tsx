// A row of options where exactly one is on. Built on the UI SDK's SegmentedControl (@ui-sdk/react, beta),
// chosen over a Radix ToggleGroup because it is a real radio group with a roving tab stop and it reports
// the checked item's box as CSS variables, so the sliding pill is one CSS transition: no layout animation
// library, nothing measured in React, nothing that can shift the page.
// This file is the only place the SDK is imported, so replacing it is a one-file change.
import type { ReactNode } from 'react';
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from '@ui-sdk/react/segmented-control';
import { cn } from 'cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

export function Segmented<T extends string>({ value, onValueChange, options, label, className, stretch = false }: {
  value: T;
  onValueChange(value: T): void;
  options: readonly SegmentedOption<T>[];
  /** The group's accessible name. */
  label: string;
  className?: string;
  stretch?: boolean;
}) {
  return (
    <SegmentedControl<T>
      value={value}
      onValueChange={next => onValueChange(next as T)}
      aria-label={label}
      className={cn('relative isolate inline-flex max-w-full gap-1 rounded-full border border-line bg-card-2/70 p-1', stretch && 'flex w-full', className)}
    >
      <SegmentedControlIndicator
        className="absolute rounded-full bg-card shadow-xs ring-1 ring-line transition-[left,width,top,height] duration-300 ease-out"
        style={{ top: 'var(--segmented-control-indicator-top)', left: 'var(--segmented-control-indicator-left)', width: 'var(--segmented-control-indicator-width)', height: 'var(--segmented-control-indicator-height)' }}
      />
      {options.map(option => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          className={cn(
            'relative z-[1] inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-sm font-medium whitespace-nowrap text-ink-soft outline-offset-1 transition-colors select-none coarse:h-11',
            'hov:text-ink data-[checked]:font-semibold data-[checked]:text-ink [&_svg]:size-4 [&_svg]:shrink-0',
            stretch && 'flex-1',
          )}
        >
          {option.icon}
          <span>{option.label}</span>
          {option.count != null ? <span className="num text-2xs text-ink-soft max-sm:hidden">{option.count.toLocaleString()}</span> : null}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
