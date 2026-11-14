import * as React from 'react';
import { cn } from 'cn';

export const fieldSurface = cn(
  'w-full min-w-0 rounded-md border border-line-strong bg-card px-3.5 text-base text-ink shadow-xs outline-none',
  'transition-[border-color,box-shadow] duration-200 placeholder:text-ink-soft/80',
  'focus-visible:border-sage focus-visible:ring-4 focus-visible:ring-sage/15 focus-visible:outline-none',
  'aria-invalid:border-danger aria-invalid:ring-danger/15 disabled:cursor-not-allowed disabled:opacity-55',
  'dark:bg-card-2',
);

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldSurface,
        'h-11 py-2 file:me-3 file:inline-flex file:h-8 file:rounded-full file:border-0 file:bg-sage-pale file:px-3 file:text-sm file:font-semibold file:text-sage dark:file:text-sage-deep',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
