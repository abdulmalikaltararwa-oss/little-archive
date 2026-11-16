// The privacy policy and the terms, on the public site. They open outside the app: in a browser tab on the web,
// and in the phone's own browser from the phone app (a link with target="_blank" leaves the web view there).
import { cn } from 'cn';
import { ExternalLink } from 'lucide-react';
import { PRIVACY_URL, TERMS_URL } from '@/lib/site';

const LINK = 'inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-semibold text-sage underline-offset-4 hov:underline dark:text-sage-deep';

export function LegalLink({ to, className }: { to: 'privacy' | 'terms'; className?: string }) {
  return (
    <a href={to === 'privacy' ? PRIVACY_URL : TERMS_URL} target="_blank" rel="noopener noreferrer" className={cn(LINK, className)}>
      {to === 'privacy' ? 'Privacy policy' : 'Terms'}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only"> (opens outside the app)</span>
    </a>
  );
}

export function LegalLinks({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-5', className)}>
      <LegalLink to="privacy" />
      <LegalLink to="terms" />
    </div>
  );
}
