// The unlock screen. The purchase itself is not built yet (its API is being written), so this screen sells
// nothing: it reports what the server says about this library (GET /api/features, GET /api/account) and
// leaves a typed placeholder where the purchase will go. Self-hosters are always unlocked and see no offer.
import { useEffect, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { ArrowLeft, Check, Lock } from 'lucide-react';
import { useArchive, useArchiveState } from '@/app/archive-context';
import { Notice, Whisper } from '@/components/field';
import { Ascii } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { Account, FeatureName } from '@/data/types';
import { FeatureHeader } from '../feature-kit';
import type { UnlockPurchase } from '../seams/contracts';

const ROWS: [FeatureName, string, string][] = [
  ['recipes', 'Recipe cards and cook mode', 'A saved dish, laid out to cook from.'],
  ['places', 'Places on a map', 'The spots your saves mention, where they are.'],
  ['ask', 'Ask your archive', 'A question, answered from what you kept.'],
  ['guided_import', 'Guided Instagram and TikTok import', 'Your whole backlog, from the platform’s own export.'],
];

/**
 * Where the purchase will be offered. Nothing can be passed yet: `UnlockPurchase` has no members until the
 * purchase API exists, so this renders only the fact that it is coming.
 */
function PurchaseSlot({ offer }: { offer: UnlockPurchase | null }) {
  if (offer) return null; // The real offer will be drawn here.
  return (
    <Notice tone="petal" className="mt-6">
      <strong className="font-semibold">The one-time unlock is not on sale in this build.</strong>
      <p className="mt-1 text-ink-soft">When it is, it will be offered here: one payment, no subscription. Nothing on this screen charges you.</p>
    </Notice>
  );
}

export default function UnlockScreen({ demo }: { demo: boolean }) {
  const archive = useArchive();
  const features = useArchiveState(state => state.features);
  const known = useArchiveState(state => state.featuresKnown);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountError, setAccountError] = useState('');
  const real = archive.backend.real;

  useEffect(() => { document.title = `Unlock — Little Archive${demo ? ' demo' : ''}`; }, [demo]);
  useEffect(() => {
    if (!real) return;
    let stale = false;
    archive.api.account().then(value => { if (!stale) setAccount(value); }, caught => { if (!stale) setAccountError(errorMessage(caught)); });
    return () => { stale = true; };
  }, [archive, real]);

  const selfHosted = (features?.mode ?? account?.mode ?? archive.backend.mode) === 'self-hosted';
  const unlocked = features?.unlocked ?? account?.entitlements.unlocked ?? selfHosted;
  const reads = account?.entitlements.deep_reads;

  return (
    <div data-seam="unlock" className="mx-auto max-w-2xl pb-10">
      <FeatureHeader
        whisper="a one-time unlock"
        title={unlocked ? 'Everything is open.' : 'Pay once, keep it.'}
        lede={selfHosted ? 'On your own server Little Archive is free, all of it, always. There is nothing to buy.' : unlocked ? 'This account has the unlock. Thank you for keeping the lights on.' : 'Saving, searching, importing and exporting are free. A few extras open with a single payment.'}
      />
      <div className="flex flex-col items-start gap-6 sm:flex-row">
        <Ascii name="key" className="shrink-0 text-base text-sage max-sm:hidden dark:text-sage-deep" />
        <ul className="w-full divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
          {ROWS.map(([name, title, line]) => {
            const flag = features?.[name];
            const open = flag ? flag.available && !flag.locked : false;
            return (
              <li key={name} className="flex items-center gap-4 px-5 py-4">
                <span className={open ? 'grid size-8 shrink-0 place-items-center rounded-full bg-sage-pale text-sage dark:text-sage-deep' : 'grid size-8 shrink-0 place-items-center rounded-full bg-card-2 text-ink-soft'}>
                  {open ? <Check className="size-4" aria-hidden="true" strokeWidth={2.4} /> : <Lock className="size-4" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{title}</span>
                  <span className="block text-xs text-ink-soft">{line}</span>
                </span>
                <span className="label-mono shrink-0">{!known ? '…' : !flag ? 'not on this server' : flag.locked ? 'locked' : flag.available ? 'open' : 'not set up'}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {reads ? (
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-card-2 px-4 py-3"><dt className="label-mono">This library</dt><dd className="mt-1 text-ink">{account?.mode === 'hosted' ? 'Hosted account' : 'Your own server'}</dd></div>
          <div className="rounded-md bg-card-2 px-4 py-3"><dt className="label-mono">Closer reads this month</dt><dd className="num mt-1 text-ink">{reads.limit == null ? `${reads.used} used · no limit` : `${reads.used} of ${reads.limit} used`}</dd></div>
        </dl>
      ) : null}
      {!real ? <Notice className="mt-4">This demo has no account. On a real server this screen shows what your library may use.</Notice> : null}
      {accountError && !features ? <Notice className="mt-4">This server did not report an account status: {accountError}</Notice> : null}

      {!unlocked ? <PurchaseSlot offer={null} /> : null}
      <div className="mt-8"><Whisper>self-hosted is free, always</Whisper></div>
      <Button className="mt-4" onClick={() => archive.goView('all')}><ArrowLeft />Back to your library</Button>
    </div>
  );
}
