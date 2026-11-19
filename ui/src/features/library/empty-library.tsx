// A library with nothing in it yet. Instead of only a drawing and a button it teaches the quickest way to save in
// the place it is open: the share sheet inside the phone app, pasting a link in a browser. The words come from
// emptyLibraryWords and are true for each place; the small pictures are decoration and the headings carry the steps.
import { Ellipsis, Plus, Settings, Share, Sparkles, Upload } from 'lucide-react';
import { useArchive, useBusy } from '@/app/archive-context';
import { openDialog, toast } from '@/app/ui-state';
import { Mark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { emptyLibraryWords } from './words';

/** The share button to look for. The petal ring marks the one thing to find in the step. */
function SharePicture() {
  return (
    <div aria-hidden="true" className="mt-3 flex items-center gap-3 rounded-md bg-card-2 p-2.5">
      <span className="m-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-card text-ink ring-2 ring-petal ring-offset-2 ring-offset-card-2"><Share className="size-4" /></span>
      <span className="text-xs text-ink-soft">An arrow leaving a box, or a paper plane.</span>
    </div>
  );
}

/** A share sheet's row of apps, with Little Archive in it. */
function AppsPicture() {
  const tile = 'grid size-10 place-items-center rounded-[11px] bg-card-3 text-ink-soft';
  return (
    <div aria-hidden="true" className="mt-3 flex items-start gap-3 overflow-hidden rounded-md bg-card-2 p-2.5">
      <span className={tile} />
      <span className={tile} />
      <span className="flex shrink-0 flex-col items-center gap-1 text-[0.625rem] leading-tight font-semibold text-ink">
        <span className="m-0.5 grid size-9 place-items-center rounded-[11px] ring-2 ring-petal ring-offset-2 ring-offset-card-2"><Mark size={36} /></span>
        Little Archive
      </span>
      <span className={tile}><Ellipsis className="size-4" /></span>
    </div>
  );
}

export function EmptyLibrary() {
  const archive = useArchive();
  const [demoBusy, runDemo] = useBusy();
  const words = emptyLibraryWords(archive.backend.kind);
  const addDemo = () => runDemo(async () => {
    const result = await archive.api.addDemo();
    await archive.refreshLibrary();
    toast(result.created ? `${result.created} synthetic demo saves added.` : 'Your demo saves are already here.');
  });

  return (
    <section aria-labelledby="empty-library-title" data-testid="empty-library" className="mx-auto max-w-xl">
      <h2 id="empty-library-title" className="display text-2xl text-balance text-ink sm:text-3xl">{words.title}</h2>
      <ol className="mt-5 flex flex-col gap-2.5">
        {words.steps.map((step, index) => (
          <li key={step.title} className="flex gap-3 rounded-lg border border-line bg-card p-3.5">
            <span aria-hidden="true" className="num grid size-7.5 shrink-0 place-items-center rounded-full bg-sage-pale text-sm text-sage dark:text-sage-deep">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <h3 className="text-base leading-snug font-semibold text-ink">{step.title}</h3>
              <p className="mt-0.5 text-sm text-ink-soft">{step.body}</p>
              {step.picture === 'share' ? <SharePicture /> : step.picture === 'apps' ? <AppsPicture /> : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => openDialog({ kind: 'save-link' })}><Plus />Save a link</Button>
        <Button onClick={() => openDialog({ kind: 'import' })}><Upload />Import your saves</Button>
        <Button variant="ghost" aria-busy={demoBusy || undefined} onClick={() => void addDemo()}><Sparkles />Try demo saves</Button>
      </div>
      {words.extension ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="text-sm leading-relaxed text-ink-soft">{words.extension}</p>
          <Button variant="link" size="sm" className="mt-1" onClick={() => openDialog({ kind: 'settings', section: 'connections' })}><Settings />Set it up in Settings</Button>
        </div>
      ) : null}
    </section>
  );
}
