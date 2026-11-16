// The one dialog that asks before saved content is sent to an AI service. It says what is sent and who receives
// it, in the server's own terms, and has two answers. Escape, the close button and a press outside all mean
// "Not now"; focus starts on "Not now", so a stray Enter never sends anything.
import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Whisper } from '@/components/field';
import { LegalLink } from '@/components/legal-links';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { useAiPermission } from './gate';

export function AiPermissionHost() {
  const request = useAiPermission(state => state.request);
  const settle = useAiPermission(state => state.settle);
  const notNow = useRef<HTMLButtonElement>(null);
  // The last question is kept so the dialog can finish closing with its words still in place.
  const [last, setLast] = useState(request);
  if (request && request !== last) setLast(request);
  const shown = request ?? last;
  if (!shown) return null;
  const { disclosure } = shown;

  return (
    <Modal
      open={Boolean(request)}
      onClose={() => settle(false)}
      size="sm"
      title={disclosure.title}
      description="Nothing is sent unless you allow it."
      opener={shown.opener}
      initialFocus={notNow}
      testId="ai-permission"
      footer={
        <>
          <Button ref={notNow} onClick={() => settle(false)}>Not now</Button>
          <Button variant="primary" onClick={() => settle(true)}><Check />Allow</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-ink">
        <section aria-labelledby="ai-permission-sent">
          <h3 id="ai-permission-sent" className="mb-1.5"><Whisper>what is sent</Whisper></h3>
          <ul className="flex list-disc flex-col gap-1 ps-5">
            {disclosure.sent.map(line => <li key={line}>{line}</li>)}
          </ul>
          {disclosure.notes ? <p className="mt-1.5 text-ink-soft">{disclosure.notes}</p> : null}
        </section>
        <section aria-labelledby="ai-permission-who">
          <h3 id="ai-permission-who" className="mb-1.5"><Whisper>who receives it</Whisper></h3>
          <p>{disclosure.recipients}</p>
        </section>
        <p className="text-ink-soft">{disclosure.remembered}</p>
        <LegalLink to="privacy" className="-my-2 self-start" />
      </div>
    </Modal>
  );
}
