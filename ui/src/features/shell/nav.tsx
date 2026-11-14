// The library's navigation: views, collections, sources, and the screens arriving next. The same content is
// the wide screen's sidebar and the phone's Browse sheet.
import type { ReactNode } from 'react';
import { PLATFORM_NAMES } from '@web/utils.js';
import { cn } from 'cn';
import { Activity, Archive, Bookmark, Clock, CookingPot, Ellipsis, Folder, Heart, LayoutGrid, MapPinned, MessageCircleQuestion, Plus, Settings, ShieldCheck, Sparkles } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { openDialog } from '@/app/ui-state';
import { Whisper } from '@/components/field';
import { PlatformIcon } from '@/components/icons';
import type { Screen } from '@/data/location';
import type { Collection, Platform } from '@/data/types';
import { VIEW_TITLE_ID } from '@/lib/focus';

const DOTS: Record<string, string> = { '#c9959c': 'bg-petal', '#8ea8b7': 'bg-[#8ea8b7]', '#c4aa70': 'bg-[#c4aa70]', '#94a98b': 'bg-[#94a98b]' };

function collectionDot(color: string | null | undefined) {
  return DOTS[String(color ?? '').toLowerCase()] ?? 'bg-[#94a98b]';
}

function NavButton({ navKey, active, icon, label, count, onClick, title, nested, soon }: { navKey: string; active?: boolean; icon: ReactNode; label: string; count?: number | null; onClick(): void; title?: string; nested?: boolean; soon?: boolean }) {
  return (
    <button
      type="button"
      data-nav-key={navKey}
      aria-current={active ? 'page' : undefined}
      title={title}
      onClick={onClick}
      className={cn(
        'group/nav flex min-h-10 w-full min-w-0 items-center gap-2.5 rounded-md px-3 text-start text-sm text-ink-soft outline-offset-[-2px] transition-[background-color,color,transform] duration-200 coarse:min-h-11',
        'hov:translate-x-0.5 hov:bg-card/60 hov:text-ink [&>svg]:size-[1.05rem] [&>svg]:shrink-0',
        active && 'bg-card font-semibold text-ink shadow-xs ring-1 ring-line [&>svg]:text-sage',
        nested && 'ps-7 text-[0.8rem]',
      )}
    >
      {icon}
      <span dir="auto" className="min-w-0 flex-1 truncate">{label}</span>
      {soon ? <span className="label-mono shrink-0 rounded-full bg-butter-pale px-1.5 !text-[0.58rem] !text-butter-ink">soon</span> : null}
      {count != null ? <span className={cn('num shrink-0 rounded-full px-2 py-0.5 text-2xs', active ? 'bg-sage-pale text-sage dark:text-sage-deep' : 'bg-card-2 text-ink-soft')}>{Number(count).toLocaleString()}</span> : null}
    </button>
  );
}

function Group({ label, action, children, navLabel }: { label: string; action?: ReactNode; children: ReactNode; navLabel?: string }) {
  const Tag = navLabel ? 'nav' : 'div';
  return (
    <Tag aria-label={navLabel} className="flex flex-col gap-0.5">
      <div className="mb-1 flex h-7 items-center justify-between ps-3 pe-1">
        <Whisper>{label}</Whisper>
        {action}
      </div>
      {children}
    </Tag>
  );
}

export function NavContent({ onNavigate }: { onNavigate?(): void }) {
  const archive = useArchive();
  const stats = useArchiveState(state => state.stats);
  const collections = useArchiveState(state => state.collections);
  const loc = useArchiveState(state => state.loc);
  const collectionId = useArchiveState(state => state.filters.collection_id);
  const library = loc.screen === 'library';

  const go = (view: string) => {
    archive.goView(view);
    onNavigate?.();
    // Chosen from the phone's sheet, the new view announces itself: focus lands on its heading.
    if (onNavigate) requestAnimationFrame(() => document.getElementById(VIEW_TITLE_ID)?.focus({ preventScroll: true }));
  };
  const screen = (next: Screen) => { archive.navigate({ screen: next, item: '' }); onNavigate?.(); };
  const dialog = (spec: Parameters<typeof openDialog>[0]) => { onNavigate?.(); openDialog(spec); };
  const isView = (view: string) => library && loc.view === view;
  const locals = collections.filter(collection => collection.kind === 'local');
  const sources = (platform: Platform) => collections.filter(collection => collection.kind === 'source' && collection.platform === platform);
  const collectionButton = (collection: Collection, nested = false) => (
    <NavButton
      key={collection.id}
      navKey={`collection:${collection.id}`}
      active={library && collectionId === collection.id}
      icon={nested ? <Folder aria-hidden="true" /> : <span aria-hidden="true" className={cn('mx-[3px] size-2.5 shrink-0 rounded-full ring-2 ring-card', collectionDot(collection.color))} />}
      label={collection.name}
      count={collection.count || 0}
      nested={nested}
      title={nested ? `${collection.name} · original source collection` : collection.name}
      onClick={() => go(`collection:${collection.id}`)}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <Group label="your library" navLabel="Library views">
        <NavButton navKey="all" active={isView('all')} icon={<LayoutGrid aria-hidden="true" />} label="All saves" count={stats.total} onClick={() => go('all')} />
        <NavButton navKey="favorites" active={isView('favorites')} icon={<Heart aria-hidden="true" />} label="Favorites" count={stats.favorites} onClick={() => go('favorites')} />
        <NavButton navKey="revisit" active={isView('revisit')} icon={<Clock aria-hidden="true" />} label="To revisit" count={stats.to_revisit} onClick={() => go('revisit')} />
        <NavButton navKey="review" active={isView('review')} icon={<Sparkles aria-hidden="true" />} label="Needs review" count={stats.needs_review} onClick={() => go('review')} />
        <NavButton navKey="rediscover" active={isView('rediscover')} icon={<Bookmark aria-hidden="true" />} label="Rediscover" onClick={() => go('rediscover')} />
      </Group>

      <Group
        label="collections"
        action={
          <button type="button" aria-label="Create a collection" title="Create a collection" onClick={() => dialog({ kind: 'collection' })} className="hit-44 grid size-7 place-items-center rounded-full text-ink-soft transition-colors hov:bg-card hov:text-ink">
            <Plus className="size-4" aria-hidden="true" />
          </button>
        }
      >
        {locals.map(collection => (
          <div key={collection.id} className="group/row flex items-center gap-0.5">
            {collectionButton(collection)}
            <button
              type="button"
              data-nav-key={`edit:${collection.id}`}
              aria-label={`Edit ${collection.name}`}
              title={`Edit ${collection.name}`}
              onClick={() => dialog({ kind: 'collection', collection })}
              className="hit-44 grid size-7 shrink-0 place-items-center rounded-full text-ink-soft opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hov:bg-card hov:text-ink [@media(hover:none)]:opacity-100"
            >
              <Ellipsis className="size-4" aria-hidden="true" />
            </button>
          </div>
        ))}
        {locals.length ? null : <NavButton navKey="first-collection" icon={<Plus aria-hidden="true" />} label="Make your first collection" onClick={() => dialog({ kind: 'collection' })} />}
      </Group>

      <Group label="from your sources">
        {(['instagram', 'tiktok', 'web'] as const).map(platform => (
          <div key={platform} className="flex flex-col gap-0.5">
            <NavButton navKey={`platform:${platform}`} active={isView(`platform:${platform}`)} icon={<PlatformIcon platform={platform} />} label={PLATFORM_NAMES[platform] ?? platform} count={stats.platforms?.[platform] || 0} onClick={() => go(`platform:${platform}`)} />
            {sources(platform).map(collection => collectionButton(collection, true))}
          </div>
        ))}
      </Group>

      {/* Seams for the next wave. Each leads to a placeholder screen that says so. */}
      <Group label="arriving next">
        <NavButton navKey="recipes" active={loc.screen === 'recipes'} icon={<CookingPot aria-hidden="true" />} label="Recipes" soon onClick={() => screen('recipes')} />
        <NavButton navKey="places" active={loc.screen === 'places'} icon={<MapPinned aria-hidden="true" />} label="Places" soon onClick={() => screen('places')} />
        <NavButton navKey="ask" active={loc.screen === 'ask'} icon={<MessageCircleQuestion aria-hidden="true" />} label="Ask your archive" soon onClick={() => screen('ask')} />
      </Group>

      <div className="flex flex-col gap-0.5 border-t border-line pt-4">
        <NavButton navKey="archived" active={isView('archived')} icon={<Archive aria-hidden="true" />} label="Archived" count={stats.archived} onClick={() => go('archived')} />
        <NavButton navKey="activity" icon={<Activity aria-hidden="true" />} label="Import activity" onClick={() => dialog({ kind: 'activity' })} />
        <NavButton navKey="settings" icon={<Settings aria-hidden="true" />} label="Settings & connections" onClick={() => dialog({ kind: 'settings' })} />
        <p className="mt-3 flex gap-2 px-3 text-xs leading-relaxed text-ink-soft">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>Self-hosted &amp; open source.<br />A small place of your own.</span>
        </p>
      </div>
    </div>
  );
}
