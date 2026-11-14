// The one way the app says "not now": what happened, when it changes, what you can do. Used as a dialog
// (when a button's action is refused) and as an inline card (on a screen whose whole content was refused).
import { KeyRound } from 'lucide-react';
import { useArchive } from '@/app/archive-context';
import type { OpenDialog } from '@/app/ui-state';
import { AsciiProgress } from '@/components/fx/ascii';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { describeRefusal, whenText, type Refusal, type RefusalKind } from './refusals';

const ART: Record<RefusalKind, string> = {
  unlock: String.raw`
   .--.
  ( () )=====#
   '--'    # #`,
  allowance: String.raw`
  .-----.
   \ . /
    ) (
   / ' \
  '-----'`,
  busy: String.raw`
   _   _   _
  (_) (_) (_)
   .   .   .`,
  storage: String.raw`
  .---------.
  |#########|
  |#########|
  '---------'`,
  purchase: String.raw`
  .-------.
  | [ ? ] |
  '-------'`,
};

export function RefusalBody({ refusal, onUnlock }: { refusal: Refusal; onUnlock?(): void }) {
  const when = whenText(refusal);
  return (
    <div className="flex flex-col items-center text-center">
      <pre aria-hidden="true" className="ascii m-0 mb-4 text-start text-sm text-sage dark:text-sage-deep">{ART[refusal.kind].replace(/^\n/, '')}</pre>
      <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{refusal.body}</p>
      {refusal.usage ? (
        <div className="mt-4 flex flex-col items-center gap-1">
          <AsciiProgress label="Allowance used" value={Math.min(refusal.usage.used, refusal.usage.limit)} max={Math.max(1, refusal.usage.limit)} width={18} />
          <span className="num text-xs text-ink-soft">{refusal.usage.used} of {refusal.usage.limit} used</span>
        </div>
      ) : null}
      {when ? <p className="label-mono mt-4 rounded-full bg-butter-pale px-3 py-1 !text-butter-ink">{when}</p> : null}
      {refusal.action === 'unlock' && onUnlock ? <Button variant="primary" className="mt-5" onClick={onUnlock}><KeyRound />About the unlock</Button> : null}
    </div>
  );
}

export function RefusalDialog({ spec, close }: { spec: Extract<OpenDialog, { kind: 'refusal' }>; close(): void }) {
  const archive = useArchive();
  const refusal = describeRefusal(spec.error);
  if (!refusal) return null;
  return (
    <Modal open={spec.open} onClose={close} size="sm" title={refusal.title} opener={spec.opener} footer={<Button onClick={close}>{refusal.action === 'wait' ? 'All right' : 'Close'}</Button>}>
      <div role="status" className="pt-2 pb-1">
        <RefusalBody refusal={refusal} onUnlock={() => { close(); archive.goScreen('unlock'); }} />
      </div>
    </Modal>
  );
}
