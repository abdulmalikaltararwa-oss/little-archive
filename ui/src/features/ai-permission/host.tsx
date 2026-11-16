// The one dialog that asks before saved content is sent to an AI service. It says what is sent and who receives
// it, in the server's own terms, and has two answers. Escape, the close button and a press outside all mean
// "Not now"; focus starts on "Not now", so a stray Enter never sends anything.
import { useRef, useState } from 'react';
import { cn } from 'cn';
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
      description="Nothing is sent unless you allow it. One answer covers every action listed here."
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
          <ul className="flex flex-col gap-2">
            {disclosure.lines.map(line => (
              <li key={line.key} className={cn('rounded-md border px-3.5 py-2.5', line.current ? 'border-transparent bg-sage-pale' : 'border-line bg-card-2')}>
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <strong className="font-semibold">{line.name}</strong>
                  {line.current ? <span className="label-mono">what you just asked for</span> : null}
                </span>
                <span className="mt-0.5 block text-ink-soft">{line.text}</span>
              </li>
            ))}
          </ul>
          {disclosure.notes ? <p className="mt-2 text-ink-soft">{disclosure.notes}</p> : null}
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
