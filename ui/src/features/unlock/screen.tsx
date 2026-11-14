// The unlock screen. On your own server there is nothing to buy and it says so. On the hosted service it
// shows what the account may use and, when it is locked, offers the one-time unlock: inside the app through
// the store's own sheet (Backend.purchases), and in a browser by saying the purchase happens in the app.
// The server alone decides what is unlocked (GET /api/features, GET /api/purchases); a store proof is handed
// to it and its answer, including every way it can say no, is shown as it is.
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, KeyRound, Lock, RotateCw, Smartphone } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { Bloom } from '@/components/brand';
import { Notice, Whisper } from '@/components/field';
import { Ascii, AsciiSpinner } from '@/components/fx/ascii';
import { Button } from '@/components/ui/button';
import type { Account, FeatureName, Purchases } from '@/data/types';
import { FeatureHeader } from '../feature-kit';
import { RefusalBody } from '../refusals/refusal';
import { describeRefusal } from '../refusals/refusals';
import type { FeatureScreenProps } from '../screens';
import { buy, restore, settle, unlockView, VIA, type PurchaseOutcome } from './purchase';

const ROWS: [FeatureName, string, string][] = [
  ['recipes', 'Recipe cards and cook mode', 'A saved dish, laid out to cook from.'],
  ['places', 'Places on a map', 'The spots your saves mention, where they are.'],
  ['ask', 'Ask your archive', 'A question, answered from what you kept.'],
  ['guided_import', 'Guided Instagram and TikTok import', 'Your whole backlog, from the platform’s own export. Always free.'],
];

const TITLES = { loading: 'One moment…', 'self-hosted': 'Everything is open.', unlocked: 'Everything is open.', 'buy-here': 'Pay once, keep it.', 'buy-in-app': 'Pay once, keep it.' } as const;
const LEDES = {
  loading: 'Checking what this account may use.',
  'self-hosted': 'On your own server Little Archive is free, all of it, always. There is nothing to buy.',
  unlocked: 'This account has the unlock. Thank you for keeping the lights on.',
  'buy-here': 'Saving, searching, importing and exporting are free. A few extras open with a single payment: no subscription, nothing to cancel.',
  'buy-in-app': 'Saving, searching, importing and exporting are free. A few extras open with a single payment: no subscription, nothing to cancel.',
} as const;

export default function UnlockScreen({ demo }: FeatureScreenProps) {
  const archive = useArchive();
  const { backend } = archive;
  const features = useArchiveState(state => state.features);
  const known = useArchiveState(state => state.featuresKnown);
  const [account, setAccount] = useState<Account | null>(null);
  const [purchases, setPurchases] = useState<Purchases | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [outcome, setOutcome] = useState<PurchaseOutcome | null>(null);
  const [buying, runBuy] = useBusy();
  const [restoring, runRestore] = useBusy();
  const [checking, runCheck] = useBusy();
  const store = backend.purchases;
  const mode = features?.mode ?? account?.mode ?? backend.mode;

  useEffect(() => { document.title = `Unlock — Little Archive${demo ? ' demo' : ''}`; }, [demo]);

  // What the server says about this account. A self-hosted server has no purchases route, and says so with 404.
  useEffect(() => {
    if (!backend.real) return;
    let stale = false;
    archive.api.account().then(value => { if (!stale) setAccount(value); }, () => {});
    if (mode === 'hosted') archive.api.purchases().then(value => { if (!stale) setPurchases(value); }, () => {});
    return () => { stale = true; };
  }, [archive, backend.real, mode, version]);

  useEffect(() => {
    if (!store?.price) return;
    let stale = false;
    store.price().then(value => { if (!stale) setPrice(value); }, () => {});
    return () => { stale = true; };
  }, [store]);

  const unlocked = purchases?.unlocked ?? features?.unlocked ?? account?.entitlements.unlocked ?? null;
  const view = backend.real ? unlockView({ mode, unlocked, known, hasStore: Boolean(store) }) : 'self-hosted';
  const via = purchases?.unlocked_via ?? account?.entitlements.unlocked_via ?? null;

  const finish = useCallback(async (result: PurchaseOutcome) => {
    setOutcome(result);
    if (result.kind === 'unlocked') {
      toast(result.restored ? 'Your unlock is back. Everything is open.' : 'Unlocked. Thank you for keeping the lights on.', { tone: 'saved' });
      await archive.refreshMetadata();
      setVersion(value => value + 1);
    } else if (result.kind === 'cancelled') toast('No purchase was made.');
    else if (result.kind === 'nothing-to-restore') toast('This store account has no Little Archive unlock to restore.');
  }, [archive]);

  const purchase = () => runBuy(async () => {
    if (!store) return;
    // The store binds the purchase to this account, so the server can tell whose it is.
    const accountId = account?.user_id ?? (await archive.api.account()).user_id;
    if (!accountId) throw new Error('This account could not be identified. Sign in again and try once more.');
    await finish(await buy(store, accountId, archive.api.submitPurchase));
  });
  const bringBack = () => runRestore(async () => { if (store) await finish(await restore(store, archive.api.submitPurchase)); });
  const checkAgain = () => runCheck(async () => {
    if (outcome?.kind === 'pending') await finish(await settle(outcome.proof, archive.api.submitPurchase));
    else { await archive.refreshMetadata(); setVersion(value => value + 1); }
  });

  const refusal = outcome?.kind === 'refused' ? describeRefusal(outcome.error) : null;
  const reads = account?.entitlements.deep_reads;

  return (
    <div data-unlock={view} className="mx-auto max-w-2xl pb-10">
      <FeatureHeader whisper="a one-time unlock" title={TITLES[view]} lede={LEDES[view]} />

      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
        {ROWS.map(([name, title, line]) => {
          const flag = features?.[name];
          const open = view === 'self-hosted' ? Boolean(flag?.available ?? true) : Boolean(flag?.available && !flag.locked);
          return (
            <li key={name} className="flex items-center gap-4 px-5 py-4">
              <span className={open ? 'grid size-8 shrink-0 place-items-center rounded-full bg-sage-pale text-sage dark:text-sage-deep' : 'grid size-8 shrink-0 place-items-center rounded-full bg-card-2 text-ink-soft'}>
                {open ? <Check className="size-4" aria-hidden="true" strokeWidth={2.4} /> : <Lock className="size-4" aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">{title}</span>
                <span className="block text-xs text-ink-soft">{line}</span>
              </span>
              <span className="label-mono shrink-0">{!known ? '…' : !flag ? (backend.real ? 'not on this server' : 'not in the demo') : flag.locked ? 'locked' : flag.available ? 'open' : 'not set up'}</span>
            </li>
          );
        })}
      </ul>

      {view === 'loading' ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-ink-soft"><AsciiSpinner />Checking this account…</p> : null}

      {view === 'unlocked' ? (
        <div className="mt-6 flex items-center gap-4 rounded-xl bg-sage-pale px-5 py-4">
          <Bloom size={40} />
          <div className="min-w-0 text-sm text-ink">
            <p className="font-semibold">Unlocked{via && VIA[via] ? ` through ${VIA[via]}` : ''}.</p>
            {purchases?.purchases.length ? (
              <ul className="mt-1 text-xs text-ink-soft">
                {purchases.purchases.map(entry => <li key={`${entry.provider}-${entry.product_id}`} className="num">{VIA[entry.provider]} · {entry.status}</li>)}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {view === 'buy-here' ? (
        <section aria-label="Unlock" className="mt-6 rounded-xl border border-line bg-card p-6 text-center">
          <Ascii name="key" className="mx-auto mb-4 w-fit text-start text-sm text-sage dark:text-sage-deep" />
          {price ? <p className="display text-4xl text-ink">{price}</p> : null}
          <p className="label-mono mt-1">once · no subscription</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="primary" size="lg" aria-busy={buying || undefined} disabled={buying || restoring} onClick={() => void purchase()}>
              {buying ? <AsciiSpinner className="text-on-sage" /> : <KeyRound />}
              Unlock once
            </Button>
            <Button variant="ghost" size="lg" aria-busy={restoring || undefined} disabled={buying || restoring} onClick={() => void bringBack()}><RotateCw />Restore a purchase</Button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">Paid through {VIA[store?.provider ?? ''] ?? 'the store'}, which handles the payment. Little Archive never sees your card.</p>
        </section>
      ) : null}

      {view === 'buy-in-app' ? (
        <Notice tone="sage" className="mt-6 flex gap-3">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-sage dark:text-sage-deep" aria-hidden="true" />
          <div>
            <strong className="font-semibold">The purchase happens in the app.</strong>
            <p className="mt-1 text-ink-soft">Open Little Archive on your iPhone or Android phone and unlock it there, through the App Store or Google Play. Once it is done, this account is unlocked everywhere you sign in.</p>
            <Button size="sm" className="mt-3" aria-busy={checking || undefined} disabled={checking} onClick={() => void checkAgain()}><RotateCw />I have unlocked it: check again</Button>
          </div>
        </Notice>
      ) : null}

      <div role="status" aria-live="polite">
        {outcome?.kind === 'pending' ? (
          <Notice tone="petal" className="mt-4">
            <strong className="font-semibold">The store is still completing the payment.</strong>
            <p className="mt-1 text-ink-soft">Nothing more is needed from you. When the payment goes through, the unlock follows; you can check again in a little while.</p>
            <Button size="sm" className="mt-3" aria-busy={checking || undefined} disabled={checking} onClick={() => void checkAgain()}><RotateCw />Check again</Button>
          </Notice>
        ) : null}
        {refusal ? (
          <section className="mt-4 rounded-xl border border-line bg-card px-6 py-6">
            <h2 className="display mb-3 text-center text-2xl text-ink">{refusal.title}</h2>
            <RefusalBody refusal={refusal} />
          </section>
        ) : null}
        {outcome?.kind === 'failed' ? <Notice className="mt-4" role="status"><strong className="font-semibold">That did not go through.</strong> <span className="text-ink-soft">{outcome.message}</span></Notice> : null}
      </div>

      {reads && view !== 'self-hosted' ? (
        <p className="num mt-4 text-xs text-ink-soft">Closer reads this month: {reads.limit == null ? `${reads.used} used, no limit` : `${reads.used} of ${reads.limit} used`}. Your allowances are in Settings.</p>
      ) : null}
      {!backend.real ? <Notice className="mt-4">This demo has no account. On the hosted service this screen shows what your account may use and offers the unlock.</Notice> : null}

      <div className="mt-8"><Whisper>self-hosted is free, always</Whisper></div>
      <Button className="mt-4" onClick={() => archive.goView('all')}><ArrowLeft />Back to your library</Button>
    </div>
  );
}
