// Organize: add a topic or a collection to every save in a scope (all of it, not just the pages loaded),
// queue AI suggestions for the scope, and step through what needs review.
import { useMemo, useState, type FormEvent } from 'react';
import { countLabel, errorMessage, libraryScope } from '@web/utils.js';
import { Activity, Check, CircleCheck, FolderPlus, Plus, Sparkles } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { openDialog, toast } from '@/app/ui-state';
import { allowAi } from '@/features/ai-permission/gate';
import { Field, FormError, Section } from '@/components/field';
import { Modal } from '@/components/modal';
import { Pick } from '@/components/pick';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openReview } from '../actions';
import { skippedWhy } from '../refusals/refusals';
import type { DialogProps } from './basic';

type ScopeName = 'all' | 'view' | 'review';

const SCOPES: { value: ScopeName; label: string }[] = [
  { value: 'all', label: 'Whole active library' },
  { value: 'view', label: 'Current view' },
  { value: 'review', label: 'Needs review' },
];

export function OrganizeDialog({ spec, close }: DialogProps<'organize'>) {
  const archive = useArchive();
  const demo = archive.backend.kind === 'demo';
  const stats = useArchiveState(state => state.stats);
  const total = useArchiveState(state => state.total);
  const settings = useArchiveState(state => state.settings);
  const collections = useArchiveState(state => state.collections);
  const locals = useMemo(() => collections.filter(collection => collection.kind === 'local'), [collections]);
  // The view as it was when Organize opened: "Current view" means that one, whatever happens behind the dialog.
  const [viewFilters] = useState(() => ({ ...archive.store.getState().filters }));
  const [scope, setScope] = useState<ScopeName>('all');
  const [topic, setTopic] = useState('');
  const [collection, setCollection] = useState('');
  const [topicError, setTopicError] = useState('');
  const [collectionError, setCollectionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [working, setWorking] = useState<'' | 'tag' | 'collection'>('');
  const [queueBusy, runQueue] = useBusy();
  const [reviewBusy, runReview] = useBusy();

  const currentScope = () => libraryScope(viewFilters, scope);
  const inScope = scope === 'all' ? stats.total : scope === 'review' ? stats.needs_review : total;

  const update = async (action: 'tag' | 'collection', value: string, fail: (message: string) => void) => {
    fail('');
    setWorking(action);
    try {
      if (!value) throw new Error(action === 'tag' ? 'Enter a topic.' : 'Choose a local collection.');
      const result = await archive.api.bulk({ filters: currentScope(), action, value });
      await archive.refreshLibrary();
      setFeedback(`${countLabel(result.updated, 'save')} updated. Original source collections are preserved.`);
    } catch (caught) {
      fail(errorMessage(caught));
    } finally {
      setWorking('');
    }
  };

  const queue = async () => {
    if (!(await allowAi(archive, 'suggest'))) return;
    await runQueue(async () => {
      const result = await archive.api.queueAi({ filters: currentScope() });
      toast(`${result.queued} queued · ${result.unchanged} already current · ${result.matched} matched.${result.skipped ? ` ${result.skipped} left for later: ${skippedWhy(result.limit?.scope)}.` : ''}`);
      close();
      openDialog({ kind: 'activity', tab: 'ai' });
    });
  };

  return (
    <Modal
      open={spec.open}
      onClose={close}
      title="Organize your library"
      description="Keep your original collections, then add topics and local collections that make the saves useful to you."
      opener={spec.opener}
      footer={
        <>
          <Button variant="soft" aria-busy={reviewBusy || undefined} disabled={reviewBusy} onClick={() => void runReview(async () => { const filters = currentScope(); close(); await openReview(archive, filters); })}><CircleCheck />Review matching saves</Button>
          <Button variant="primary" onClick={close}><Check />Done</Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Field label="Organization scope"><Pick<ScopeName> value={scope} options={SCOPES} onChange={setScope} /></Field>
        <p role="status" className="text-xs leading-relaxed text-ink-soft">
          <span className="num text-ink">{countLabel(inScope, 'save')}</span> in this scope. Every matching page is included, even if you have not loaded it.
        </p>
      </div>

      <div className="mt-5">
        <Section title="Add a topic">
          <form noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); void update('tag', topic.trim(), setTopicError); }} className="flex flex-col gap-3">
            <FormError message={topicError} />
            <Field label="Topic to add"><Input required maxLength={80} placeholder="e.g. Recipes to try" dir="auto" value={topic} onChange={event => setTopic(event.target.value)} /></Field>
            <div><Button type="submit" variant="soft" aria-busy={working === 'tag' || undefined} disabled={working !== ''}><Plus />Add topic to matching saves</Button></div>
          </form>
        </Section>

        <Section title="Collect matching saves">
          <form noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); void update('collection', collection, setCollectionError); }} className="flex flex-col gap-3">
            <FormError message={collectionError} />
            <Field label="Local collection to add">
              <Pick value={collection || undefined} placeholder="Choose a local collection" disabled={!locals.length} options={locals.map(entry => ({ value: entry.id, label: entry.name }))} onChange={setCollection} />
            </Field>
            <div><Button type="submit" variant="soft" aria-busy={working === 'collection' || undefined} disabled={!locals.length || working !== ''}><FolderPlus />Add matches to collection</Button></div>
            {locals.length ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs">Make a local collection first.</p>
                <Button variant="ghost" size="sm" onClick={() => { close(); openDialog({ kind: 'collection' }); }}><Plus />Create a collection</Button>
              </div>
            )}
          </form>
        </Section>

        {feedback ? <p role="status" className="mb-6 rounded-md bg-sage-pale px-4 py-3 text-sm text-ink">{feedback}</p> : null}

        <Section title={settings.ai_hosted || archive.backend.mode === 'hosted' ? 'Let AI suggest topics' : 'Let local AI suggest topics'}>
          <p>
            {settings.ai_hosted
              ? 'Queue the complete scope. A hosted AI service receives each save’s title, caption, creator and any transcript. You review every suggestion before it changes your organization.'
              : 'Queue the complete scope. Suggestions use available titles, captions, notes, and collection names. You review them before they change your organization.'}
          </p>
          {demo || !settings.ai_enabled ? (
            <p className="text-xs">
              {demo
                ? 'Local AI is unavailable in the synthetic demo. Manual topics and collections work in memory.'
                : archive.backend.mode === 'hosted' ? 'AI suggestions are not offered on this service. Manual topics and collections work now.' : 'Local AI is not configured. Manual topics and collections work now; your server can optionally connect a local Ollama model.'}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={demo || !settings.ai_enabled || queueBusy} aria-busy={queueBusy || undefined} onClick={() => void queue()}><Sparkles />Queue topic suggestions</Button>
            <Button size="sm" className="h-10.5" onClick={() => { close(); openDialog({ kind: 'activity', tab: 'ai' }); }}><Activity />View job progress</Button>
          </div>
        </Section>
      </div>
    </Modal>
  );
}
