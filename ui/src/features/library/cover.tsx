// A save's face: its stored thumbnail, a remote preview the owner has allowed, or a paper cover set in type.
import { memo, useEffect, useRef, useState } from 'react';
import { hostLabel, PLATFORM_NAMES, safeURL, stableHue } from '@web/utils.js';
import { cn } from 'cn';
import { Bookmark, Play } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import type { Item } from '@/data/types';

// Six papers. Each pairs a pale ground with an ink that passes AA on it (checked in tokens.test.ts).
const PAPERS = [
  'bg-sage-pale text-sage dark:text-sage-deep',
  'bg-petal-pale text-petal-ink',
  'bg-butter-pale text-butter-ink',
  'bg-sky-pale text-sky-ink',
  'bg-clay-pale text-clay-ink',
  'bg-lilac-pale text-lilac-ink',
];

// The ASCII accent on a paper cover: a quiet pattern in one corner, different for each paper.
const ORNAMENTS = [
  '    _\n  _(_)_\n (_)@(_)\n   (_)\n    |\n   \\|/',
  '~ ~ ~ ~ ~ ~\n ~ ~ ~ ~ ~\n~ ~ ~ ~ ~ ~\n ~ ~ ~ ~ ~\n~ ~ ~ ~ ~ ~',
  '. * . * . *\n* . * . * .\n. * . * . *\n* . * . * .\n. * . * . *',
  '  .-----.\n (  .-.  )\n( (  o  ) )\n (  \'-\'  )\n  \'-----\'',
  '+ - + - + -\n|   |   |\n+ - + - + -\n|   |   |\n+ - + - + -',
  '/ / / / / /\n / / / / /\n/ / / / / /\n / / / / /\n/ / / / / /',
];

export function TextCover({ item, detail = false }: { item: Pick<Item, 'id' | 'title' | 'url' | 'platform'>; detail?: boolean }) {
  const hue = stableHue(item.title || item.id);
  return (
    <div aria-hidden="true" className={cn('relative flex size-full flex-col justify-center overflow-hidden', PAPERS[hue], detail ? 'p-8' : 'p-4 sm:p-5')}>
      <pre className={cn('ascii pointer-events-none absolute -end-1 -bottom-1 m-0 opacity-30', detail ? 'text-sm' : 'text-2xs')}>{ORNAMENTS[hue]}</pre>
      <span className="label-mono relative mb-2 !text-current opacity-80">{PLATFORM_NAMES[item.platform] || 'A little discovery'}</span>
      <span dir="auto" className={cn('display relative line-clamp-4 text-balance', detail ? 'max-w-[18ch] text-3xl' : 'text-lg leading-tight sm:text-xl')}>
        {item.title || hostLabel(item.url)}
      </span>
    </div>
  );
}

/** A paper cover the size of a thumbnail: the paper and one mark, since a title set in type would not be readable. */
function MiniCover({ item }: { item: Pick<Item, 'id' | 'title' | 'content_type'> }) {
  const Mark = item.content_type === 'video' ? Play : Bookmark;
  return (
    <div aria-hidden="true" className={cn('grid size-full place-items-center', PAPERS[stableHue(item.title || item.id)])}>
      <Mark className="size-5" strokeWidth={1.8} />
    </div>
  );
}

interface CoverProps {
  item: Item;
  remotePreviews: boolean;
  detail?: boolean;
  /** A thumbnail beside a line of text (the list): no labels over it. */
  mini?: boolean;
  className?: string;
}

export const Cover = memo(function Cover({ item, remotePreviews, detail = false, mini = false, className }: CoverProps) {
  const { backend } = useArchive();
  const thumbnail = backend.thumbnail(item.thumbnail_url);
  const remote = !thumbnail && remotePreviews ? safeURL(item.preview_url) : null;
  const source = thumbnail?.type === 'url' ? thumbnail.src : remote;
  const key = `${item.thumbnail_url ?? ''}|${remote ?? ''}`;
  const [failed, setFailed] = useState('');
  const [ready, setReady] = useState('');
  const image = useRef<HTMLImageElement>(null);
  const attach = thumbnail?.type === 'attach' ? thumbnail.attach : null;

  // Inside the app a thumbnail is fetched with the bearer token and shown from a blob URL.
  useEffect(() => {
    if (attach && image.current) attach(image.current);
    // The path is the identity of the picture; a new function for the same path must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const hasImage = Boolean(thumbnail || remote) && failed !== key;
  return (
    <div className={cn('relative size-full overflow-hidden bg-card-2', className)}>
      {hasImage ? (
        <img
          ref={image}
          src={source ?? undefined}
          alt=""
          loading={detail ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setReady(key)}
          onError={() => setFailed(key)}
          className={cn('size-full object-cover transition-opacity duration-300', ready === key ? 'opacity-100' : 'opacity-0')}
        />
      ) : mini ? (
        <MiniCover item={item} />
      ) : (
        <TextCover item={item} detail={detail} />
      )}
      {!hasImage && !detail && !mini ? <span className="label-mono absolute start-2.5 bottom-2 rounded-full bg-card/85 px-2 py-0.5 !text-[0.56rem] !text-ink-soft">Text preview</span> : null}
      {item.content_type === 'video' && !detail && !mini ? (
        <span title="Video link" className="absolute end-2.5 bottom-2.5 grid size-7 place-items-center rounded-full bg-card/90 text-ink shadow-xs">
          <Play className="size-3 fill-current" aria-hidden="true" />
          <span className="sr-only">Video</span>
        </span>
      ) : null}
    </div>
  );
});
