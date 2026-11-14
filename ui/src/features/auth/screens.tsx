// The two screens before the library: opening (or failing to open), and the owner's sign-in on a self-hosted
// server. Inside the app the shell has its own sign-in and these are never shown.
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage, hostLabel } from '@web/utils.js';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Brand, Mark } from '@/components/brand';
import { Field, FormError, Notice, Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { TextScramble } from '@/components/fx/text-scramble';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const AsciiFieldCanvas = lazy(() => import('@/components/fx/ascii-field'));

export function BootScreen({ error, onRetry }: { error?: string; onRetry?(): void }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
      <Mark size={56} className={error ? undefined : 'animate-bob'} />
      {error ? (
        <>
          <h1 className="display text-3xl text-ink">Your archive is taking a moment.</h1>
          <p role="alert" className="max-w-sm text-sm text-ink-soft">{error}</p>
          <Button variant="primary" onClick={onRetry}><ArrowRight />Try again</Button>
        </>
      ) : (
        <>
          <h1 className="display text-3xl text-ink">Little Archive</h1>
          <p role="status" className="flex items-center gap-2 text-sm text-ink-soft"><AsciiSpinner />Opening your little corner of the internet…</p>
        </>
      )}
    </main>
  );
}

export function LoginScreen() {
  const archive = useArchive();
  const notice = useArchiveState(state => state.loginNotice);
  const share = useArchiveState(state => state.pendingShare);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [wide] = useState(() => matchMedia('(min-width: 1024px)').matches);

  useEffect(() => { document.title = 'Little Archive — Welcome home'; }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await archive.login(password);
      setPassword('');
    } catch (caught) {
      setError(errorMessage(caught));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section aria-label="About Little Archive" className="hero-paper relative isolate flex min-h-[280px] flex-col justify-between overflow-hidden px-6 pt-[calc(var(--safe-top)+1.5rem)] pb-6 sm:px-12 lg:min-h-dvh lg:px-[9%] lg:py-12">
        {/* The field keeps to its own corner so the words are never set over it: beside them on a phone, above them on a wide screen. */}
        <div className="absolute end-0 top-0 -z-10 h-full max-h-[340px] w-[46%] [mask-image:linear-gradient(to_left,black_65%,transparent)] lg:top-[5%] lg:h-[50%] lg:max-h-none lg:w-[84%] lg:[mask-image:linear-gradient(to_bottom,black_72%,transparent)]">
          <Suspense fallback={null}>
            <AsciiFieldCanvas anchor={wide ? 0.6 : 0.5} />
          </Suspense>
        </div>
        <Brand />
        <div className="mt-8 max-lg:max-w-[58%] lg:mt-auto lg:pt-[52vh]">
          <Whisper className="max-lg:hidden">a home for your curious mind</Whisper>
          <h1 className="display mt-3 text-[2.5rem] leading-[1.02] text-ink sm:text-6xl lg:text-[5.2rem] lg:leading-[0.98]">Good things,<br />kept close.</h1>
          <p className="mt-4 max-w-sm text-sm text-ink-soft sm:text-base">Your saved posts, ideas, and little discoveries. Together in a space that belongs to you.</p>
        </div>
        <p className="mt-10 flex items-center gap-2 text-xs text-ink-soft max-lg:hidden"><ShieldCheck className="size-4" aria-hidden="true" />Open source. Self-hosted. Yours to keep.</p>
      </section>

      <main id="main" className="flex items-center justify-center px-6 py-10 pb-[calc(var(--safe-bottom)+2.5rem)] sm:px-10">
        <div className="w-full max-w-[380px]">
          <Whisper><TextScramble>welcome home</TextScramble></Whisper>
          <h2 className="display mt-2 text-4xl text-ink">Your archive awaits.</h2>
          <p className="mt-2.5 mb-7 text-sm text-ink-soft sm:text-base">Sign in to pick up where your curiosity left off.</p>
          {share?.shared ? (
            <Notice role="status" tone="sage" className="mb-5">
              {share.url ? `Sign in to review and save the link you shared from ${hostLabel(share.url)}. It is waiting for you.` : 'Sign in to finish saving what you shared.'}
            </Notice>
          ) : null}
          <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
            <FormError message={error} />
            <Field label="Password">
              <Input ref={input} type="password" name="password" autoComplete="current-password" required placeholder="Your archive password" value={password} onChange={event => setPassword(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy || undefined}>
              Open my archive
              {busy ? <AsciiSpinner className="text-on-sage" /> : <ArrowRight />}
            </Button>
          </form>
          <p className="mt-6 text-xs leading-relaxed text-ink-soft">Use the owner password configured when this instance was installed. Need to reset it? Your server administrator can use the local password-reset command.</p>
        </div>
      </main>
    </div>
  );
}
