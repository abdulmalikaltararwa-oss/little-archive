// Step two: how to get the export. Everything here is the server's guide, drawn: the steps (by their stable
// ids), what to choose in the platform's own form, which file format is best, what the file contains, what is
// never read, and, in plain sight, what the guide has and has not been checked against.
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import type { Guide } from './api';
import { Aside, Bullets, ExternalLink, Path, StepHeading } from './parts';

const CHOOSE_LABELS: Record<string, string> = { information: 'Information', format: 'Format', date_range: 'Date range' };

const asText = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(', ') : String(value ?? ''));

/** What the guide rests on and what is not verified: a callout with a butter edge, always shown, never folded away. */
function Honesty({ guide }: { guide: Guide }) {
  const { verified } = guide;
  return (
    <section aria-labelledby="guide-honesty" data-honesty className="mb-6 rounded-md border border-line border-s-[5px] border-s-butter bg-card px-5 py-4">
      <h3 id="guide-honesty"><Whisper>what this guide rests on</Whisper></h3>
      <p dir="auto" className="mt-2 text-sm leading-relaxed text-ink">
        These steps come from {verified.basis}.{' '}
        {verified.real_export_tested ? `They were checked against a real ${guide.name} export.` : `They have not been checked against a real ${guide.name} export, so a menu may be worded a little differently from what is written here.`}
      </p>
      {verified.unverified.length ? (
        <div className="mt-3">
          <p className="label-mono">not verified</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {verified.unverified.map(entry => <li key={entry} dir="auto" className="rounded-full bg-butter-pale px-2.5 py-1 text-xs leading-snug text-butter-ink">{entry}</li>)}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-ink-soft">The preview shows what was found before anything is saved, so a layout we got wrong shows up there and not in your library.</p>
    </section>
  );
}

export function GuideView({ guide, onBack, onAdd }: { guide: Guide; onBack(): void; onAdd(): void }) {
  return (
    <>
      <Button variant="ghost" size="sm" className="-ms-2 mb-2" onClick={onBack}><ArrowLeft />All platforms</Button>
      <StepHeading title={`Get your ${guide.name} export`} lede={<span dir="auto">{guide.summary}</span>} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <div className="min-w-0">
          <Honesty guide={guide} />
          {guide.help_url ? <p className="-mt-3 mb-5"><ExternalLink href={guide.help_url}>{guide.name}’s own instructions</ExternalLink></p> : null}
          <ol role="list" className="flex flex-col" aria-label={`Steps to get your ${guide.name} export`}>
            {guide.steps.map((step, index) => {
              const last = index === guide.steps.length - 1;
              return (
                <li key={step.id} data-step-id={step.id} className="relative flex gap-4">
                  <div className="flex flex-col items-center">
                    <span className="num grid size-8 shrink-0 place-items-center rounded-full bg-sage-pale text-xs text-sage ring-1 ring-sage/20 dark:text-sage-deep" aria-hidden="true">{index + 1}</span>
                    {last ? null : <span aria-hidden="true" className="my-1 w-px flex-1 bg-line-strong/60" />}
                  </div>
                  <div className={last ? 'min-w-0 flex-1' : 'min-w-0 flex-1 pb-6'}>
                    <h3 dir="auto" className="pt-1 text-base font-semibold text-ink">{step.title}</h3>
                    <p dir="auto" className="mt-1 text-sm leading-relaxed text-ink-soft">{step.detail}</p>
                    {step.id === 'upload' ? <Button variant="primary" className="mt-4" onClick={onAdd}>I have the file<ArrowRight /></Button> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Aside title="what to choose">
            <dl className="flex flex-col gap-2.5">
              {Object.entries(guide.choose).map(([key, value]) => (
                <div key={key}>
                  <dt className="label-mono">{CHOOSE_LABELS[key] ?? key.replaceAll('_', ' ')}</dt>
                  <dd dir="auto" className="text-sm font-semibold text-ink">{asText(value)}</dd>
                </div>
              ))}
            </dl>
          </Aside>

          <Aside title="which format">
            <ul className="flex flex-col gap-2.5">
              {guide.formats.map(format => (
                <li key={format.id} data-format={format.id} className="rounded-md bg-card-2 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-sm font-medium text-ink uppercase">{format.id}</span>
                    {format.recommended ? <span className="label-mono rounded-full bg-sage-pale px-2 py-0.5 !text-sage dark:!text-sage-deep">recommended</span> : null}
                  </div>
                  <p dir="auto" className="mt-1.5 text-xs leading-relaxed text-ink-soft">Reads {format.reads.join('; ')}.</p>
                  {format.limitations?.length ? <Bullets className="mt-2 !text-xs !text-ink-soft" items={format.limitations} /> : null}
                </li>
              ))}
            </ul>
          </Aside>

          <Aside title="what is inside">
            <ul className="flex flex-col gap-2.5">
              {guide.expect.map(entry => (
                <li key={entry.file}>
                  <Path value={entry.file} className="block text-xs text-ink" />
                  <span dir="auto" className="text-xs text-ink-soft">{entry.contains}</span>
                </li>
              ))}
            </ul>
            <p dir="auto" className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-soft">{guide.ignored}</p>
          </Aside>

          {guide.caveats.length ? (
            <Aside title="good to know">
              <Bullets className="!text-ink-soft" items={guide.caveats} />
            </Aside>
          ) : null}
        </div>
      </div>
    </>
  );
}
