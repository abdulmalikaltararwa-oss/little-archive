// Form furniture: a labelled field, the error line a form shows, a notice, and the small pieces dialogs share.
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from 'cn';
import { Checkbox } from './ui/checkbox';

export function Field({ label, help, children, className }: { label: string; help?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; className?: string }) {
  const id = useId();
  const helpId = `${id}-help`;
  const control = isValidElement(children) ? cloneElement(children, { id: children.props.id ?? id, 'aria-describedby': help ? helpId : children.props['aria-describedby'] }) : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={children.props.id ?? id} className="text-sm font-semibold text-ink">{label}</label>
      {control}
      {help ? <p id={helpId} className="text-xs leading-relaxed text-ink-soft">{help}</p> : null}
    </div>
  );
}

/** A form's own error line. It is an alert, so it is read out when it appears. */
export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-pale px-3.5 py-2.5 text-sm text-danger">
      {message}
    </div>
  );
}

export function Notice({ children, tone = 'plain', className, role }: { children: ReactNode; tone?: 'plain' | 'sage' | 'petal'; className?: string; role?: 'status' | 'note' }) {
  return (
    <div
      role={role}
      className={cn(
        'rounded-md border px-4 py-3 text-sm leading-relaxed',
        tone === 'plain' && 'border-line bg-card-2 text-ink',
        tone === 'sage' && 'border-transparent bg-sage-pale text-ink',
        tone === 'petal' && 'border-transparent bg-petal-pale text-ink',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A titled block inside a long dialog (settings, organize). */
export function Section({ title, children, className, id, ...props }: { title: string; children: ReactNode; className?: string; id?: string } & React.ComponentProps<'section'>) {
  return (
    <section id={id} className={cn('border-t border-line py-6 first:border-t-0 first:pt-1', className)} {...props}>
      <h3 className="mb-2 text-base font-semibold text-ink">{title}</h3>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

export function CheckRow({ checked, onChange, children, disabled, focusKey }: { checked: boolean; onChange(next: boolean): void; children: ReactNode; disabled?: boolean; focusKey?: string }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox id={id} checked={checked} disabled={disabled} data-detail-focus={focusKey} onCheckedChange={next => onChange(next === true)} />
      <label htmlFor={id} className="min-w-0 flex-1 py-2 text-sm text-ink" dir="auto">{children}</label>
    </div>
  );
}

/** The mono whisper used for section labels: [ like this ]. */
export function Whisper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('label-mono', className)}>
      <span aria-hidden="true" className="text-petal-ink/70">[ </span>
      {children}
      <span aria-hidden="true" className="text-petal-ink/70"> ]</span>
    </span>
  );
}
