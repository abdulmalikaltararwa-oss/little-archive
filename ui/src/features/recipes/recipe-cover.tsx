// A recipe's face: the save's stored thumbnail (or a remote preview the owner has allowed), else a sheet of
// coloured paper with a small pot drawn on it. The recipe list gives only a thumbnail address, so this works
// from that rather than from a whole save.
import { memo, useEffect, useRef, useState } from 'react';
import { safeURL, stableHue } from '@web/utils.js';
import { cn } from 'cn';
import { useArchive } from '@/app/archive-context';
import { Ascii } from '@/components/fx/ascii';

// Six papers, as in the library's text covers: each pairs a pale ground with an ink that passes AA on it.
const PAPERS = [
  'bg-sage-pale text-sage dark:text-sage-deep',
  'bg-petal-pale text-petal-ink',
  'bg-butter-pale text-butter-ink',
  'bg-sky-pale text-sky-ink',
  'bg-clay-pale text-clay-ink',
  'bg-lilac-pale text-lilac-ink',
];

function Paper({ title, large }: { title: string; large: boolean }) {
  const hue = stableHue(title);
  return (
    <div aria-hidden="true" className={cn('relative flex size-full items-end overflow-hidden', PAPERS[hue])}>
      <Ascii name="pot" className={cn('pointer-events-none absolute end-3 top-3 text-current opacity-40', large ? 'text-sm' : 'text-2xs')} />
      <span className="label-mono relative m-3 !text-current opacity-80">recipe card</span>
    </div>
  );
}

interface RecipeCoverProps {
  thumbnailUrl: string | null;
  title: string;
  previewUrl?: string | null;
  remotePreviews?: boolean;
  className?: string;
  /** The big one on a recipe's own page. */
  large?: boolean;
}

export const RecipeCover = memo(function RecipeCover({ thumbnailUrl, title, previewUrl = null, remotePreviews = false, className, large = false }: RecipeCoverProps) {
  const { backend } = useArchive();
  const thumbnail = backend.thumbnail(thumbnailUrl);
  const remote = !thumbnail && remotePreviews ? safeURL(previewUrl) : null;
  const source = thumbnail?.type === 'url' ? thumbnail.src : remote;
  const key = `${thumbnailUrl ?? ''}|${remote ?? ''}`;
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
          loading={large ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={() => setReady(key)}
          onError={() => setFailed(key)}
          className={cn('size-full object-cover transition-opacity duration-300', ready === key ? 'opacity-100' : 'opacity-0')}
        />
      ) : (
        <Paper title={title} large={large} />
      )}
    </div>
  );
});
