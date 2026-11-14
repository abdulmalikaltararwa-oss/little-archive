// The small dialogs: save a link, make or edit a collection, a bulk action that needs a value, copying text
// by hand, and deleting a hosted account.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { countLabel, errorMessage, hostLabel, isTikTokShortLink, parseTags, safeURL } from '@web/utils.js';
import { cn } from 'cn';
import { Bookmark, Trash2 } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { confirm, toast, type OpenDialog } from '@/app/ui-state';
import { CheckRow, Field, FormError, Notice } from '@/components/field';
import { Modal } from '@/components/modal';
import { Pick } from '@/components/pick';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { AccountDeletion } from '@/data/types';
import { deletionWords } from './words';

export interface DialogProps<K extends OpenDialog['kind']> {
  spec: Extract<OpenDialog, { kind: K }>;
  close(): void;
}

function CollectionChecklist({ value, onChange }: { value: string[]; onChange(next: string[]): void }) {
  const collections = useArchiveState(state => state.collections);
  const locals = useMemo(() => collections.filter(collection => collection.kind === 'local'), [collections]);
  return (
    <fieldset className="flex flex-col">
      <legend className="mb-1.5 text-sm font-semibold text-ink">Collections</legend>
      <div className="max-h-40 overflow-y-auto rounded-md border border-line px-3.5">
        {locals.length ? locals.map(collection => (
          <div key={collection.id} className="border-b border-line last:border-b-0">
            <CheckRow checked={value.includes(collection.id)} onChange={on => onChange(on ? [...value, collection.id] : value.filter(id => id !== collection.id))}>{collection.name}</CheckRow>
          </div>
        )) : <p className="py-3 text-xs text-ink-soft">Create a local collection from the sidebar to organize your saves.</p>}
      </div>
    </fieldset>
  );
}

/** `share` is a link handed over by the phone's share sheet. It only prefills the form; saving stays an explicit tap. */
export function SaveLinkDialog({ spec, close }: DialogProps<'save-link'>) {
  const archive = useArchive();
  const share = spec.share ?? null;
  const [url, setUrl] = useState(share?.url || '');
  const [title, setTitle] = useState(share?.title || '');
  const [notes, setNotes] = useState(share?.notes || '');
  const [tags, setTags] = useState('');
  const [collections, setCollections] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);

  const dismiss = () => { if (share) archive.forgetShare(); close(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (!safeURL(url)) throw new Error('Enter a complete HTTP or HTTPS link.');
      const item = await archive.api.createItem({ url: url.trim(), title: title.trim(), notes, tags: parseTags(tags), collection_ids: collections });
      dismiss();
      archive.markSaved(item.id);
      await archive.refreshLibrary();
      toast('A little discovery, safely kept.', { tone: 'saved' });
      void archive.openItem(item.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={spec.open}
      onClose={dismiss}
      title="Save a little discovery"
      description="Keep a post, article, video, or any link worth coming back to."
      opener={spec.opener}
      // A link that arrived ready to review keeps the on-screen keyboard closed, so Save stays in view.
      initialFocus={share?.url ? 'content' : urlInput}
      footer={
        <>
          <Button onClick={dismiss}>Cancel</Button>
          <Button type="submit" form="save-link-form" variant="primary" aria-busy={saving || undefined} disabled={saving}><Bookmark />Save to archive</Button>
        </>
      }
    >
      <form id="save-link-form" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        {share?.shared ? (
          <Notice role="status" tone="sage">
            <strong className="font-semibold">Shared with Little Archive. </strong>
            {share.url ? `Check the link from ${hostLabel(share.url)}, then tap Save.` : 'We could not find a web link in it. Paste the link below.'}
          </Notice>
        ) : null}
        {share?.url && isTikTokShortLink(share.url) ? (
          <Notice role="status" tone="petal">This is a TikTok short link, which Little Archive cannot save. Open the video in your browser, then share or copy its full link.</Notice>
        ) : null}
        <FormError message={error} />
        <Field label="Link"><Input ref={urlInput} type="url" inputMode="url" required placeholder="https://…" autoComplete="url" autoCapitalize="none" spellCheck={false} dir="ltr" value={url} onChange={event => setUrl(event.target.value)} /></Field>
        <Field label="Title"><Input maxLength={500} placeholder="Give it a name you’ll remember" dir="auto" value={title} onChange={event => setTitle(event.target.value)} /></Field>
        <Field label="Your notes"><Textarea maxLength={20000} placeholder="What caught your eye?" dir="auto" value={notes} onChange={event => setNotes(event.target.value)} /></Field>
        <Field label="Topics" help="Separate topics with commas."><Input placeholder="design, weekend ideas, food" dir="auto" value={tags} onChange={event => setTags(event.target.value)} /></Field>
        <CollectionChecklist value={collections} onChange={setCollections} />
      </form>
    </Modal>
  );
}

const COLOURS: [string, string][] = [['#94a98b', 'Sage'], ['#c9959c', 'Blush'], ['#8ea8b7', 'Sky'], ['#c4aa70', 'Honey']];

export function CollectionDialog({ spec, close }: DialogProps<'collection'>) {
  const archive = useArchive();
  const collection = spec.collection ?? null;
  const [name, setName] = useState(collection?.name || '');
  const [color, setColor] = useState(collection?.color || '#94a98b');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choices = useMemo(() => {
    const current = collection?.color;
    return current && !COLOURS.some(([value]) => value.toLowerCase() === current.toLowerCase()) ? [...COLOURS, [current, 'Current color'] as [string, string]] : COLOURS;
  }, [collection]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const body = { name: name.trim(), color };
      if (collection) await archive.api.patchCollection(collection.id, body);
      else await archive.api.createCollection(body);
      close();
      await archive.refreshLibrary();
      toast(collection ? 'Collection updated.' : 'Your new collection is ready.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = () => collection && confirm({
    title: 'Delete this collection?',
    message: `“${collection.name}” will be removed from this archive. Its saved items will remain.`,
    danger: true,
    action: async () => {
      await archive.api.deleteCollection(collection.id);
      close();
      if (archive.store.getState().filters.collection_id === collection.id) archive.goView('all');
      await archive.refreshLibrary();
      toast('Collection removed. Your saves are still here.');
    },
  });

  return (
    <Modal
      open={spec.open}
      onClose={close}
      size="sm"
      title={collection ? 'Edit collection' : 'Make a collection'}
      opener={spec.opener}
      initialFocus={input}
      footer={
        <>
          {collection ? <Button variant="danger-ghost" className="me-auto" onClick={() => void remove()}><Trash2 />Delete</Button> : null}
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form="collection-form" variant="primary" aria-busy={saving || undefined} disabled={saving}>{collection ? 'Save changes' : 'Create collection'}</Button>
        </>
      }
    >
      <form id="collection-form" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <FormError message={error} />
        <Field label="Name"><Input ref={input} required maxLength={200} placeholder="A place for your next obsession" dir="auto" value={name} onChange={event => setName(event.target.value)} /></Field>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Color</legend>
          <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
            {choices.map(([value, label]) => {
              const on = value.toLowerCase() === color.toLowerCase();
              return (
                <label key={value} className={cn('flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm transition-colors has-focus-visible:ring-4 has-focus-visible:ring-sage/20', on ? 'border-sage bg-sage-pale text-ink' : 'border-line bg-card text-ink-soft hov:bg-card-2')}>
                  <input type="radio" name="collection-color" value={value} checked={on} onChange={() => setColor(value)} className="sr-only" />
                  <span aria-hidden="true" className="size-3.5 rounded-full ring-2 ring-card" style={{ backgroundColor: value }} />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="text-xs leading-relaxed text-ink-soft">Local collections organize your archive independently of your original source collections.</p>
      </form>
    </Modal>
  );
}

export function BulkDialog({ spec, close }: DialogProps<'bulk'>) {
  const archive = useArchive();
  const collections = useArchiveState(state => state.collections);
  const locals = useMemo(() => collections.filter(collection => collection.kind === 'local'), [collections]);
  const topic = spec.action === 'tag';
  const [value, setValue] = useState(topic ? '' : locals[0]?.id ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const empty = !topic && !locals.length;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      const chosen = value.trim();
      if (!chosen) throw new Error(topic ? 'Enter a topic.' : 'Choose a local collection.');
      const result = await archive.api.bulk({ ids: spec.ids, action: spec.action, value: chosen });
      archive.clearSelection();
      await archive.refreshLibrary();
      toast(`${countLabel(result.updated, 'save')} updated.`);
      close();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={spec.open}
      onClose={close}
      size="sm"
      title={topic ? 'Add a topic to your selection' : 'Collect your selection'}
      opener={spec.opener}
      initialFocus={topic ? input : undefined}
      footer={empty ? <Button onClick={close}>Close</Button> : <Button type="submit" form="bulk-form" variant="primary" aria-busy={saving || undefined} disabled={saving}>Update {spec.ids.length} saves</Button>}
    >
      {empty ? (
        <p className="text-sm text-ink-soft">Create a local collection first, then add your selection to it.</p>
      ) : (
        <form id="bulk-form" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4">
          <FormError message={error} />
          {topic ? (
            <Field label="Topic"><Input ref={input} required maxLength={80} placeholder="e.g. Weekend ideas" dir="auto" value={value} onChange={event => setValue(event.target.value)} /></Field>
          ) : (
            <Field label="Collection"><Pick value={value} onChange={setValue} options={locals.map(collection => ({ value: collection.id, label: collection.name }))} /></Field>
          )}
        </form>
      )}
    </Modal>
  );
}

export function CopyTextDialog({ spec, close }: DialogProps<'copy-text'>) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.select(); }, []);
  return (
    <Modal open={spec.open} onClose={close} size="sm" title="Copy this text" description="Clipboard access is unavailable here. Select and copy the text below." opener={spec.opener} initialFocus={box} footer={<Button onClick={close}>Done</Button>}>
      <Textarea ref={box} readOnly value={spec.text} aria-label="Text to copy" className="font-mono text-sm" />
    </Modal>
  );
}

export function DeleteAccountDialog({ spec, close }: DialogProps<'delete-account'>) {
  const archive = useArchive();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AccountDeletion | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const armed = typed.trim() === 'DELETE';
  // Once the library is gone the only way on is out: the app signs this device out.
  const leave = () => void archive.backend.account?.signOut({ deleted: true });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!armed) return;
    setError('');
    setBusy(true);
    try {
      setDone(await archive.api.deleteAccount());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const words = deletionWords(done);
    return (
      <Modal open={spec.open} onClose={leave} size="sm" title={words.title} opener={spec.opener} footer={<Button variant="primary" onClick={leave}>Done</Button>}>
        <p role="status" className="text-sm leading-relaxed text-ink-soft">{words.body}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">Copies you exported or backed up are yours and are not affected.</p>
      </Modal>
    );
  }

  return (
    <Modal
      open={spec.open}
      onClose={close}
      canClose={() => !busy}
      size="sm"
      title="Delete your account"
      description="This permanently deletes your library from the service: every save, collection, note and preview, your unlock and your storage, and then your sign-in. It cannot be undone. Copies you exported or backed up are not affected."
      opener={spec.opener}
      initialFocus={input}
      footer={
        <>
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" form="delete-account-form" variant="danger" disabled={!armed || busy} aria-busy={busy || undefined}><Trash2 />Delete my account</Button>
        </>
      }
    >
      <form id="delete-account-form" noValidate onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <FormError message={error} />
        <Field label="Type DELETE to confirm"><Input ref={input} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="DELETE" value={typed} onChange={event => setTyped(event.target.value)} /></Field>
      </form>
    </Modal>
  );
}
