// A closer look at one save: its cover, what is known about it, and everything the owner can change.
// The rules carried over from the buildless interface: nothing is lost silently (leaving with unsaved edits
// asks first), an AI suggestion is shown with what it rests on and changes nothing until accepted, and only
// the fields that changed are sent.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { buildItemPatch, errorMessage, formatDate, hostLabel, parseTags, PLATFORM_NAMES, safeURL, STATUS_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { ArrowRight, Check, Copy, ExternalLink, Folder, Heart, ImagePlus, ScanSearch, Sparkles, Trash2, X } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { confirm, confirmDiscard, toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { CheckRow, Field, FormError, Whisper } from '@/components/field';
import { AsciiSpinner } from '@/components/fx/ascii';
import { BorderBeam } from '@/components/fx/border-beam';
import { PlatformIcon } from '@/components/icons';
import { Modal } from '@/components/modal';
import { Pick } from '@/components/pick';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Item, Status } from '@/data/types';
import { rememberFocus, type FocusMemory } from '@/lib/focus';
import { canMorph, COVER_TRANSITION } from '@/lib/transition';
import { copyText, openReview } from '../actions';
import { Cover } from '../library/cover';
import { PlacesEntry } from '../places/detail-entry';
import { CookBar, RecipeSection } from '../recipes/detail-entry';
import { evidenceLabel } from '../review/queue';
import { canCook, useSaveRecipe, type SaveRecipe } from '../recipes/use-save-recipe';

const STATUS_OPTIONS = (Object.entries(STATUS_NAMES) as [Status, string][]).map(([value, label]) => ({ value, label }));

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-3"><Whisper>{children}</Whisper></h3>;
}

interface Draft {
  title: string;
  summary: string;
  notes: string;
  tags: string;
  status: Status;
  review: boolean;
  collections: string[];
}

const draftOf = (item: Item): Draft => ({
  title: item.title || '',
  summary: item.summary || '',
  notes: item.notes || '',
  tags: (item.tags || []).join(', '),
  status: item.status || 'inbox',
  review: Boolean(item.needs_review),
  collections: (item.collections || []).filter(collection => collection.kind === 'local').map(collection => collection.id),
});

function Transcript({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const short = text.length > 360 ? `${text.slice(0, 360)}…` : text;
  return (
    <section aria-label="Transcript of the audio" className="border-t border-line py-5">
      <SectionTitle>what is said</SectionTitle>
      <p dir="auto" className="text-sm leading-relaxed whitespace-pre-wrap text-ink">{full ? text : short}</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">An automatic transcript of the audio. It can contain mistakes, and it says nothing about what is shown on screen.</p>
      {short !== text ? <Button variant="ghost" size="sm" className="mt-2 -ms-2" onClick={() => setFull(value => !value)}><ArrowRight />{full ? 'Show less' : 'Show all'}</Button> : null}
    </section>
  );
}

function Content({ item, version, setItem, dirty, setDirty, formId, panel, recipe }: { item: Item; version: number; setItem(next: Item, focus?: string): void; dirty: boolean; setDirty(value: boolean): void; formId: string; panel: React.RefObject<HTMLDivElement | null>; recipe: SaveRecipe }) {
  const archive = useArchive();
  const demo = archive.backend.kind === 'demo';
  const settings = useArchiveState(state => state.settings);
  const allCollections = useArchiveState(state => state.collections);
  const locals = useMemo(() => allCollections.filter(collection => collection.kind === 'local'), [allCollections]);
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [error, setError] = useState('');
  // A full record can be queued while the form is clean and rendered after the next keystroke. Check the draft
  // here, when the new version actually renders. Explicit saves reset the form in accept().
  const [startedFrom, setStartedFrom] = useState(version);
  if (startedFrom !== version) {
    setStartedFrom(version);
    if (!dirty) {
      setDraft(draftOf(item));
      setError('');
    }
  }
  const [saving, setSaving] = useState(false);
  const [favoriteBusy, runFavorite] = useBusy();
  const [aiBusy, runAi] = useBusy();
  const [toolBusy, runTool] = useBusy();
  const [reviewBusy, runReview] = useBusy();
  const fileInput = useRef<HTMLInputElement>(null);

  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); };
  const allowLeave = async () => !dirty || confirmDiscard();
  // Replaces the shown save with the server's answer; the form starts again from it.
  const accept = (updated: Item, focus?: string) => { setDraft(draftOf(updated)); setDirty(false); setError(''); setItem(updated, focus); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const patch = buildItemPatch(item, { title: draft.title.trim(), summary: draft.summary, notes: draft.notes, tags: parseTags(draft.tags), status: draft.status, needs_review: draft.review, collection_ids: draft.collections });
      if (!Object.keys(patch).length) { setDirty(false); toast('Everything is already saved.'); return; }
      const updated = await archive.api.patchItem(item.id, patch);
      accept(updated, 'save');
      await archive.refreshEditedItem(updated);
      toast('Your changes are saved.');
    } catch (caught) {
      setError(errorMessage(caught));
      panel.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
    } finally {
      setSaving(false);
    }
  };

  const toggleFavorite = () => runFavorite(async () => {
    const updated = await archive.api.patchItem(item.id, { favorite: !item.favorite });
    setItem({ ...item, favorite: updated.favorite });
    await archive.refreshEditedItem(updated);
  });

  const decide = (kind: 'accept' | 'dismiss') => runAi(async () => {
    if (!(await allowLeave())) return;
    const updated = kind === 'accept' ? await archive.api.acceptAi(item.id) : await archive.api.dismissAi(item.id);
    accept(updated, 'save');
    await archive.refreshEditedItem(updated);
    toast(kind === 'accept' ? 'Suggestions accepted.' : 'Suggestion dismissed.');
  });

  const upload = (file: File) => runTool(async () => {
    if (!(await allowLeave())) return;
    if (file.size > 8 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP smaller than 8 MiB.');
    const updated = await archive.api.uploadThumbnail(item.id, file);
    accept(updated, 'preview');
    await archive.refreshEditedItem(updated);
    toast('Local preview added.');
  });

  const removePreview = () => runTool(async () => {
    if (!(await allowLeave())) return;
    const updated = await archive.api.deleteThumbnail(item.id);
    accept(updated, 'preview');
    await archive.refreshEditedItem(updated);
  });

  const suggest = async () => {
    if (!(await allowAi(archive, 'suggest'))) return;
    await runTool(async () => {
      const result = await archive.api.queueAi({ ids: [item.id] });
      toast(result.skipped && !result.queued ? 'Not queued: the suggestions allowance is used for now.' : `${result.queued} classification job queued. Check activity, then reopen this save to review.`);
    });
  };

  const deepRead = item.enrichment?.deep_read;
  const readCloser = async () => {
    if (!(await allowLeave()) || !(await allowAi(archive, 'closer-read'))) return;
    await runTool(async () => {
      await archive.api.deepRead(item.id);
      toast('A closer read is queued. Check activity, then reopen this save.');
      accept(await archive.api.item(item.id), 'deep');
    });
  };

  const nextReview = () => runReview(async () => {
    if (!(await allowLeave())) return;
    const scope = archive.store.getState().reviewScope ?? {};
    if (item.needs_review) await archive.api.patchItem(item.id, { needs_review: false });
    setDirty(false);
    await archive.refreshLibrary();
    // The next save takes this one's place; when there is none, the panel closes.
    if (!(await openReview(archive, scope))) await archive.closeItem({ force: true });
  });

  const remove = () => confirm({
    title: 'Delete this saved item?',
    message: 'Its local notes, topics, and memberships will be deleted. Your save on the original platform is unaffected.',
    danger: true,
    action: async () => {
      await archive.api.deleteItem(item.id);
      setDirty(false);
      await archive.closeItem({ force: true });
      await archive.refreshLibrary();
      toast('Item deleted from your archive.');
    },
  });

  const originalURL = safeURL(item.url);
  const sourceCollections = (item.collections || []).filter(collection => collection.kind === 'source');
  const spoken = (item.evidence || []).find(entry => entry.kind === 'transcript' && entry.text);
  const otherEvidence = (item.evidence || []).filter(entry => !(entry.kind === 'caption' && entry.text === item.caption) && entry.kind !== 'transcript');
  const ai = item.ai && item.needs_review ? item.ai : null;
  const aiHelp = demo
    ? 'This isolated demo does not upload files or run AI. Install your own instance to use these features.'
    : settings.ai_hosted
      ? 'This uses a hosted AI service: the post’s title, caption, creator and any transcript are sent to it. A video cover is not a full video analysis.'
      : settings.ai_enabled
        ? 'AI works from available text. A video cover is not a full video analysis.'
        : 'Optional local AI is not configured. Your library works without it.';

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3 sm:mb-4">
        <span className="flex min-w-0 items-center gap-2 text-sm text-ink-soft">
          <PlatformIcon platform={item.platform} className="size-4 shrink-0" />
          <span dir="auto" className="truncate">{PLATFORM_NAMES[item.platform] || 'Web'}{item.creator ? ` · ${item.creator}` : ''}</span>
        </span>
        <button
          type="button"
          data-detail-focus="favorite"
          aria-pressed={item.favorite}
          aria-busy={favoriteBusy || undefined}
          // Not `disabled`: that would drop the keyboard's focus while the change is saved. useBusy refuses a second run.
          aria-disabled={favoriteBusy || undefined}
          aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
          title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => void toggleFavorite()}
          className={cn('hit-44 grid size-9 shrink-0 place-items-center rounded-full text-ink-soft transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97]', item.favorite ? 'bg-petal-pale text-petal-ink' : 'hov:bg-card-2 hov:text-ink')}
        >
          <Heart className={cn('size-[1.1rem]', item.favorite && 'fill-current')} aria-hidden="true" />
        </button>
      </div>
      <h2 dir="auto" className="display text-[1.75rem] leading-tight text-ink">{item.title || hostLabel(item.url)}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2 sm:mt-4">
        {demo ? (
          <span className="text-xs text-ink-soft">Illustrative source link</span>
        ) : originalURL ? (
          <Button asChild size="sm" className="flex-1">
            <a href={originalURL} target="_blank" rel="noopener noreferrer">Open original<ExternalLink /></a>
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="flex-1 text-ink-soft hov:text-ink" onClick={() => void copyText(item.url)}><Copy />Copy link</Button>
      </div>

      {sourceCollections.length ? (
        <section className="mt-5 border-t border-line pt-5">
          <SectionTitle>original collections</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {sourceCollections.map(collection => (
              <span key={collection.id} dir="auto" className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-sage-pale px-2.5 py-1 text-xs font-medium text-sage dark:text-sage-deep">
                <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                {collection.name}
              </span>
            ))}
          </div>
          <p className="mt-2.5 text-xs text-ink-soft">Kept exactly as imported from the source.</p>
        </section>
      ) : null}

      {ai ? (
        <section aria-label="AI suggestion" className="relative mt-5 rounded-lg bg-sage-pale/70 p-4">
          <BorderBeam />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Sparkles className="size-4 text-petal-ink" aria-hidden="true" />A little help organizing</h3>
            {/* The evidence label: the words that say what this suggestion rests on. The moving border only draws the eye to it. */}
            <span data-testid="evidence-label" className="label-mono rounded-full border border-sage/25 bg-card px-2 py-0.5 !text-ink">{evidenceLabel(ai)}</span>
          </div>
          <p dir="auto" className="mt-3 text-sm leading-relaxed text-ink">{ai.summary || ai.suggested_title}</p>
          {(ai.topics || []).length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(ai.topics || []).map(topic => <span key={topic} dir="auto" className="rounded-full bg-card px-2.5 py-0.5 text-xs text-ink ring-1 ring-line">{topic}</span>)}
            </div>
          ) : null}
          {ai.suggested_folder ? <p className="mt-3 text-xs text-ink-soft">Suggested folder: {ai.suggested_folder}. Accepting files this save there.</p> : null}
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">{ai.evidence_note || `Based on ${String(ai.evidence_level || 'available text').replaceAll('-', ' ')}.`} Review suggestions before accepting.</p>
          <div className="relative mt-3.5 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" aria-busy={aiBusy || undefined} disabled={aiBusy} onClick={() => void decide('accept')}><Check />Accept suggestions</Button>
            <Button variant="ghost" size="sm" disabled={aiBusy} onClick={() => void decide('dismiss')}><X />Dismiss</Button>
          </div>
        </section>
      ) : null}

      {spoken ? <div className="mt-5"><Transcript text={spoken.text} /></div> : null}

      {/* What else this save holds: a recipe to cook from, places it names. Each shows nothing where the server has no such feature. */}
      <RecipeSection item={item} state={recipe} pinned />
      <PlacesEntry item={item} allowLeave={allowLeave} />

      <form id={formId} onSubmit={event => void submit(event)} className="mt-4 flex flex-col gap-4 border-t border-line pt-4 sm:mt-5 sm:pt-5">
        <FormError message={error} />
        <Field label="Title"><Input value={draft.title} maxLength={500} dir="auto" data-detail-focus="title" onChange={event => edit('title', event.target.value)} /></Field>
        <Field label="Summary"><Textarea value={draft.summary} maxLength={4000} rows={3} dir="auto" data-detail-focus="summary" onChange={event => edit('summary', event.target.value)} /></Field>
        <Field label="Your notes"><Textarea value={draft.notes} maxLength={20000} dir="auto" placeholder="Why did you save this?" data-detail-focus="notes" onChange={event => edit('notes', event.target.value)} /></Field>
        <Field label="Topics" help={demo ? 'Separate topics with commas. Demo edits reset on reload.' : 'Separate topics with commas.'}>
          <Input value={draft.tags} dir="auto" data-detail-focus="tags" onChange={event => edit('tags', event.target.value)} />
        </Field>
        <Field label="Progress"><Pick<Status> value={draft.status} options={STATUS_OPTIONS} focusKey="status" onChange={value => edit('status', value)} /></Field>
        {/* Its label reaches into the panel's padding, so the small box has a finger-sized area on every side. */}
        <CheckRow checked={draft.review} focusKey="review" onChange={value => edit('review', value)} className="-mx-3 px-3">Keep in Needs review</CheckRow>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-semibold text-ink">Local collections</legend>
          <div className="max-h-44 overflow-y-auto rounded-md border border-line">
            {locals.length ? locals.map(collection => (
              <div key={collection.id} className="border-b border-line last:border-b-0">
                <CheckRow checked={draft.collections.includes(collection.id)} onChange={on => edit('collections', on ? [...draft.collections, collection.id] : draft.collections.filter(id => id !== collection.id))} className="px-3.5">{collection.name}</CheckRow>
              </div>
            )) : <p className="px-3.5 py-3 text-xs text-ink-soft">Create a local collection from the sidebar to organize your saves.</p>}
          </div>
        </fieldset>
        {/* The visible Save button lives in the panel's footer, so it is always in reach. This one lets Enter submit. */}
        <button type="submit" hidden disabled={saving} />
      </form>

      <section className="mt-6 border-t border-line pt-5">
        <SectionTitle>Preview and AI tools</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" data-detail-focus="preview" disabled={demo || toolBusy} title={demo ? 'Local image uploads are available in your own instance.' : undefined} onClick={() => fileInput.current?.click()}>
            <ImagePlus />
            {item.thumbnail_url ? 'Replace local preview' : 'Add a local preview'}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            tabIndex={-1}
            aria-label="Upload a local preview image"
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }}
          />
          {item.thumbnail_url && !demo ? <Button variant="ghost" size="sm" disabled={toolBusy} onClick={() => void removePreview()}><X />Remove preview</Button> : null}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" disabled={!settings.ai_enabled || toolBusy} title={settings.ai_enabled ? undefined : 'Configure an AI provider on your server to enable suggestions.'} onClick={() => void suggest()}>
            <Sparkles />
            {settings.ai_hosted ? 'Suggest topics with AI' : 'Suggest topics with local AI'}
          </Button>
          {!demo && deepRead && (deepRead.available || ['queued', 'running'].includes(deepRead.state)) ? (
            <Button size="sm" data-detail-focus="deep" disabled={!deepRead.available || toolBusy} onClick={() => void readCloser()}>
              <ScanSearch />
              {deepRead.available ? 'Read this more closely' : 'A closer read is queued'}
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">{aiHelp}</p>
        {!demo && deepRead && (deepRead.available || ['queued', 'running'].includes(deepRead.state)) ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            {deepRead.state === 'failed' && deepRead.error ? `Last try: ${deepRead.error}` : 'Sends the post’s media file (sound and picture) to a transcription service, then reads this save again from what is said. The video itself is never stored.'}
          </p>
        ) : null}
      </section>

      <details className="group/evidence mt-6 border-t border-line pt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
          Source text &amp; evidence
          <span aria-hidden="true" className="font-mono text-ink-soft group-open/evidence:hidden">[+]</span>
          <span aria-hidden="true" className="hidden font-mono text-ink-soft group-open/evidence:inline">[-]</span>
        </summary>
        <div className="flex flex-col gap-2 pt-1 pb-2">
          {item.caption ? (
            <div className="rounded-md bg-card-2 px-3.5 py-3">
              <span className="label-mono">Caption</span>
              <p dir="auto" className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{item.caption}</p>
            </div>
          ) : null}
          {otherEvidence.map((entry, index) => (
            <div key={`${entry.kind}-${index}`} className="rounded-md bg-card-2 px-3.5 py-3">
              <span className="label-mono">{String(entry.kind).replaceAll('_', ' ')}</span>
              <p dir="auto" className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{entry.text}</p>
            </div>
          ))}
          {!item.caption && !(item.evidence || []).length ? <p className="text-xs text-ink-soft">This save currently has link-only evidence. Add your own notes or import more source text.</p> : null}
        </div>
      </details>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-5 text-xs">
        {([['Added to archive', formatDate(item.created_at)], ['Saved on source', formatDate(item.saved_at)], ['Last observed', formatDate(item.last_seen_at)], ['Content type', item.content_type || 'link']] as const).map(([term, value]) => (
          <div key={term}>
            <dt className="text-ink-soft">{term}</dt>
            <dd className="num mt-0.5 text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-6 border-t border-line pt-5">
        <SectionTitle>keep reviewing</SectionTitle>
        <p className="mb-3 text-xs leading-relaxed text-ink-soft">Move through every save needing review in this scope, including unloaded pages.</p>
        <Button variant="soft" aria-busy={reviewBusy || undefined} disabled={reviewBusy} onClick={() => void nextReview()}>
          {reviewBusy ? <AsciiSpinner /> : <ArrowRight />}
          {item.needs_review ? 'Mark reviewed & next' : 'Next save to review'}
        </Button>
      </section>

      <div className="mt-8 border-t border-line pt-4">
        <Button variant="danger-ghost" size="sm" className="-ms-2" onClick={() => void remove()}><Trash2 />Delete from this archive</Button>
      </div>
    </>
  );
}

export function DetailPanel() {
  const archive = useArchive();
  const id = useArchiveState(state => (state.loc.screen === 'library' && state.phase === 'ready' ? state.loc.item : ''));
  const remotePreviews = useArchiveState(state => state.settings.remote_previews);
  // The save on show. It outlives `id` by a moment so the panel can leave with its content still in place.
  const [viewId, setViewId] = useState('');
  const [opener, setOpener] = useState<FocusMemory | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [seenId, setSeenId] = useState('');
  // Counts the times a save has been opened. The panel stays mounted between them, so what it asks once per save
  // (its recipe) is asked again on each opening.
  const [visit, setVisit] = useState(0);
  if (id !== seenId) {
    setSeenId(id);
    if (id) {
      setViewId(id);
      setVisit(count => count + 1);
      setDirtyState(false);
      // Focus returns to whatever opened the panel, found again by its save if the card was re-rendered.
      // Moving from one open save straight to the next keeps the original opener.
      if (!seenId) setOpener(rememberFocus());
    }
  }
  // What the wall already knows is shown at once; the full record replaces it when it arrives.
  const known = useArchiveState(state => (viewId ? state.items.find(entry => entry.id === viewId) : undefined));
  const [loaded, setLoaded] = useState<{ id: string; item: Item | null; error: string; version: number }>({ id: '', item: null, error: '', version: 0 });
  const dirtyRef = useRef(false);
  const wantFocus = useRef('');
  const panel = useRef<HTMLDivElement>(null);
  const formId = useId();
  const setDirty = useCallback((value: boolean) => { dirtyRef.current = value; setDirtyState(value); }, []);

  useEffect(() => {
    if (!id) {
      archive.setLeaveGuard(null);
      return;
    }
    let stale = false;
    dirtyRef.current = false;
    archive.api.item(id).then(
      item => {
        if (stale) return;
        // Where the keyboard is, if it is already inside the form. The form starts again from the full record, and a
        // control that held focus may not survive that, so focus is put back once the new content is in the page.
        const held = panel.current?.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-detail-focus]')?.dataset.detailFocus : undefined;
        if (held && !dirtyRef.current) wantFocus.current = held;
        setLoaded(current => ({ id, item, error: '', version: (current.id === id ? current.version : 0) + 1 }));
      },
      error => { if (!stale) setLoaded(current => ({ id, item: current.id === id ? current.item : null, error: errorMessage(error), version: current.id === id ? current.version : 0 })); },
    );
    archive.setLeaveGuard(async () => !dirtyRef.current || confirmDiscard());
    return () => { stale = true; };
  }, [archive, id]);

  const current = loaded.id === viewId ? loaded : null;
  const item = current?.item ?? known ?? null;
  // Whether this save has a recipe to cook from. Asked once per opening, for the section in the body and the bar in the footer.
  const recipe = useSaveRecipe(item?.id ?? '', visit);
  const cook = canCook(recipe);
  const error = current?.error ?? '';
  const version = current?.version ?? 0;

  const setItem = (next: Item, focus?: string) => {
    // The control that was used may be replaced by the new content; keep the keyboard where it was.
    if (focus) wantFocus.current = focus;
    setLoaded(previous => ({ id: next.id, item: next, error: '', version: (previous.id === next.id ? previous.version : 0) + (focus ? 1 : 0) }));
  };
  // Focus is put back after React has drawn the new content, not on the next frame: React draws a moment after the
  // answer arrives, and a frame that comes first would find (and focus) the control that is about to be replaced.
  useLayoutEffect(() => {
    const focus = wantFocus.current;
    if (!focus) return;
    wantFocus.current = '';
    panel.current?.querySelector<HTMLElement>(`[data-detail-focus="${focus}"]`)?.focus({ preventScroll: true });
  }, [loaded]);

  return (
    <Modal
      open={Boolean(id)}
      onClose={() => void archive.closeItem({ force: true })}
      canClose={async () => !dirtyRef.current || confirmDiscard()}
      title="A closer look"
      variant="panel"
      opener={opener}
      quietEnter={canMorph()}
      testId="detail"
      bodyClassName="px-0 sm:px-0 pb-0"
      footer={item ? (
        <>
          <span role="status" className={dirty ? 'label-mono me-auto' : 'sr-only'}>{dirty ? '· unsaved changes' : ''}</span>
          {/* One strong button at a time: Start cooking while the form is clean, Save once there is something to save. */}
          <Button type="submit" form={formId} variant={cook && !dirty ? 'outline' : 'primary'} data-detail-focus="save" className={cn('shadow-none hov:translate-y-0', !cook && 'min-w-40 max-sm:flex-1')}><Check />Save changes</Button>
          <CookBar item={item} state={recipe} quiet={dirty} />
        </>
      ) : undefined}
    >
      <div ref={panel}>
        {item ? (
          <>
            <div className="aspect-[1.7] w-full overflow-hidden bg-card-2 max-sm:min-h-56 sm:aspect-[1.45]" style={{ viewTransitionName: id ? COVER_TRANSITION : undefined }}>
              <Cover item={item} remotePreviews={remotePreviews} detail />
            </div>
            <div className="px-5 pt-4 pb-8 sm:px-7 sm:pt-5">
              {error ? <div className="mb-4"><FormError message={error} /></div> : null}
              <Content key={item.id} item={item} version={version} setItem={setItem} dirty={dirty} setDirty={setDirty} formId={formId} panel={panel} recipe={recipe} />
            </div>
          </>
        ) : error ? (
          <div className="px-5 py-6 sm:px-7"><FormError message={error} /></div>
        ) : (
          <p role="status" className="flex items-center justify-center gap-2 px-5 py-16 text-sm text-ink-soft"><AsciiSpinner />Opening your save…</p>
        )}
      </div>
    </Modal>
  );
}
