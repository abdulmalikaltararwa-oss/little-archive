// Step four: the dry run. The file has been read and nothing has been saved, and this view says both. The
// totals come first (they are what a person decides on), then what the file holds in more detail: the date
// range, the collections, the sections that were and were not read, a few of the saves themselves, and every
// entry that could not be read, in plain words. The one button that saves anything is here and nowhere else.
import { countLabel, formatDate, PLATFORM_NAMES, safeURL } from '@web/utils.js';
import { Download, X } from 'lucide-react';
import { Notice, Whisper } from '@/components/field';
import { Button } from '@/components/ui/button';
import type { GuidedImport, Preview } from './api';
import { Aside, Chevron, Panel, Path, Stat, StepHeading } from './parts';
import { groupUnreadable } from './words';

function Totals({ preview }: { preview: Preview }) {
  const t = preview.totals;
  return (
    // Two large tallies, then four small ones: on a wide screen 2 + 2 across the top and 4 under, on a phone 2 across each row.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="What the file holds">
      <Stat strong value={t.saves} label="saves found" gloss="distinct posts in the file" className="sm:col-span-2" />
      <Stat strong value={t.new} label="new" gloss="not in your library yet" className="sm:col-span-2" />
      <Stat value={t.already_in_library} label="already here" gloss="refreshed, never overwritten" />
      <Stat value={t.duplicates_in_archive} label="repeats" gloss="listed more than once in the file" />
      <Stat value={t.unreadable} label="unreadable" gloss="could not be read at all" />
      <Stat value={t.in_collections_only} label="only in a collection" gloss="found there, with no save date" />
    </div>
  );
}

function Range({ preview }: { preview: Preview }) {
  const range = preview.date_range;
  return (
    <Aside title="saved between">
      {range ? (
        <p className="num text-sm text-ink">{formatDate(range.first)} <span aria-hidden="true">→</span><span className="sr-only">to</span> {formatDate(range.last)}</p>
      ) : (
        <p className="text-sm text-ink-soft">This file carries no save dates.</p>
      )}
    </Aside>
  );
}

function Collections({ preview }: { preview: Preview }) {
  const shown = preview.collections;
  const more = Math.max(0, preview.collections_total - shown.length);
  return (
    <Aside title="collections">
      {!preview.collections_read ? (
        <p className="text-sm leading-relaxed text-ink-soft">Collections were not read from this file, so saves come in without them.</p>
      ) : !shown.length ? (
        <p className="text-sm text-ink-soft">The file lists no collections.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {shown.map(collection => (
              <li key={collection.name} className="flex items-center justify-between gap-3 rounded-md bg-card-2 px-3.5 py-2.5">
                {/* A name is shown whole, wrapping if it must: collection names are often long, and often Arabic. */}
                <span dir="auto" className="min-w-0 flex-1 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{collection.name}</span>
                <span className="label-mono shrink-0">{collection.exists ? 'in your library' : 'new'}</span>
                <span className="num shrink-0 rounded-full bg-sage-pale px-2 py-0.5 text-2xs text-sage dark:text-sage-deep">{collection.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
          {more ? <p className="mt-2 text-xs text-ink-soft">and {more.toLocaleString()} more.</p> : null}
        </>
      )}
    </Aside>
  );
}

function Read({ preview }: { preview: Preview }) {
  const { ignored } = preview;
  const unread = [
    ...ignored.sections.map(section => `${section.name}: ${section.count.toLocaleString()} recognised and left alone`),
    ...(ignored.files ? [`${countLabel(ignored.files, 'other file')} never opened`] : []),
    ...(ignored.nested_archives ? [`${countLabel(ignored.nested_archives, 'ZIP inside the ZIP')} ignored`] : []),
  ];
  return (
    <Aside title="what was read">
      {preview.sections.length ? (
        <ul className="flex flex-col gap-1.5">
          {preview.sections.map(section => (
            <li key={section.name} className="flex items-baseline justify-between gap-3 text-sm">
              <span dir="auto" className="min-w-0 truncate text-ink">{section.name}</span>
              <span className="num text-xs text-ink-soft">{section.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {preview.files.length ? (
        <details className="group/d mt-3 border-t border-line pt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-ink [&::-webkit-details-marker]:hidden"><Chevron />{countLabel(preview.files.length, 'file')} opened</summary>
          <ul className="flex flex-col gap-2 pb-2">
            {preview.files.map(file => (
              <li key={file.path} className="text-xs">
                <Path value={file.path} className="block text-ink" />
                <span className="text-ink-soft">{countLabel(file.entries, 'entry', 'entries')}{file.error ? ' · ' : ''}</span>
                {file.error ? <span dir="auto" className="text-danger">{file.error}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="mt-3 border-t border-line pt-3">
        <Whisper>left unread</Whisper>
        {unread.length ? (
          <ul className="mt-2 flex flex-col gap-1.5 text-xs leading-relaxed text-ink-soft">
            {unread.map(line => <li key={line} dir="auto">{line}</li>)}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-soft">Nothing else was found in the file.</p>
        )}
      </div>
    </Aside>
  );
}

function Sample({ preview }: { preview: Preview }) {
  if (!preview.sample.length) return null;
  return (
    <Aside title="a few of them">
      <ul className="flex flex-col gap-2">
        {preview.sample.map((save, index) => {
          const href = safeURL(save.url);
          return (
            <li key={`${save.url}-${index}`} className="flex flex-col gap-0.5 rounded-md bg-card-2 px-3.5 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span dir="auto" className="min-w-0 truncate text-sm font-semibold text-ink">{save.creator || 'Creator not in the file'}</span>
                <span className="num shrink-0 text-xs text-ink-soft">{save.saved_at ? formatDate(save.saved_at) : 'no date'}</span>
              </div>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" dir="auto" className="num truncate text-xs text-sage underline-offset-2 hov:underline dark:text-sage-deep">{save.url}<span className="sr-only"> (opens in a new tab)</span></a>
              ) : (
                <span dir="auto" className="num truncate text-xs text-ink-soft">{save.url}</span>
              )}
              {save.collections.length ? <p dir="auto" className="text-xs text-ink-soft">In {save.collections.join(', ')}</p> : null}
            </li>
          );
        })}
      </ul>
    </Aside>
  );
}

function Unreadable({ preview }: { preview: Preview }) {
  if (!preview.unreadable_total) return null;
  const groups = groupUnreadable(preview.unreadable);
  const listed = preview.unreadable.length;
  return (
    <Aside title="could not be read">
      <p className="text-sm leading-relaxed text-ink">{countLabel(preview.unreadable_total, 'entry', 'entries')} could not be read, so they are not in the totals above and will not be imported.</p>
      <ul className="mt-3 flex flex-col gap-1.5 text-sm text-ink-soft">
        {groups.map(group => (
          <li key={group.reason} className="flex gap-3">
            <span className="num w-7 shrink-0 text-end text-ink">{group.count}</span>
            <span dir="auto">{group.words}</span>
          </li>
        ))}
      </ul>
      {listed < preview.unreadable_total ? <p className="mt-2 text-xs text-ink-soft">The reasons are listed for the first {listed.toLocaleString()} of them.</p> : null}
      <details className="group/d mt-2 border-t border-line pt-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-ink [&::-webkit-details-marker]:hidden"><Chevron />Every listed entry</summary>
        <ul className="flex flex-col gap-1.5 pb-2 text-xs text-ink-soft">
          {preview.unreadable.map((entry, index) => (
            <li key={`${entry.file}-${entry.index}-${index}`}>
              <Path value={entry.file} className="text-ink" /> · entry {entry.index} · <span dir="auto">{groupUnreadable([entry])[0]?.words}</span>
            </li>
          ))}
        </ul>
      </details>
    </Aside>
  );
}

export function PreviewView({ view, busy, onCommit, onCancel }: { view: GuidedImport; busy: boolean; onCommit(): void; onCancel(): void }) {
  const preview = view.preview;
  if (!preview) return null;
  const t = preview.totals;
  const name = PLATFORM_NAMES[preview.platform] ?? preview.platform;
  return (
    <>
      <StepHeading
        whisper="a dry run · nothing is saved yet"
        title="Here is what we found"
        lede={<>Your {name} file has been read and <strong className="font-semibold text-ink">nothing has been saved</strong>. Look it over, then bring it in.</>}
      />
      <div className="flex flex-col gap-4">
        <Totals preview={preview} />

        {t.in_library_other_account > 0 ? (
          <Notice tone="petal" role="note">
            <strong className="font-semibold">{countLabel(t.in_library_other_account, 'save')} already in your library under another account name.</strong>
            <span className="mt-1 block text-ink-soft">This import uses the account name “<span dir="auto">{preview.source_account}</span>”, so those would be added a second time. To match them instead, cancel this import and add the file again with the other account name.</span>
          </Notice>
        ) : null}
        {preview.warnings.map((warning, index) => <Notice key={index} tone="petal" role="note"><span dir="auto">{warning}</span></Notice>)}
        {t.saves === 0 ? <Notice tone="petal" role="note"><strong className="font-semibold">There is nothing to import.</strong> <span className="text-ink-soft">No saves could be read from this file.</span></Notice> : null}

        <Panel tone="sage" className="!p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" disabled={busy || t.saves === 0} aria-busy={busy || undefined} onClick={onCommit}>
              <Download />
              {busy ? 'Starting…' : `Import ${countLabel(t.saves, 'save')}`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onCancel}><X />Cancel this import</Button>
          </div>
          <p className="mt-3 max-w-xl text-xs leading-relaxed text-ink-soft">Nothing is saved until you press this. Saves already in your library are refreshed from the file, never overwritten, and nothing is ever removed. Titles, notes and tags you wrote are kept.</p>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <Range preview={preview} />
            <Collections preview={preview} />
            <Unreadable preview={preview} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Sample preview={preview} />
            <Read preview={preview} />
          </div>
        </div>
      </div>
    </>
  );
}
