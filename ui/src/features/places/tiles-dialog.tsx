// "Map tiles": where the owner says which tile server the map may ask for pictures. Off until they do. It says
// plainly what a tile server learns, asks before contacting a server that has not been used yet, and checks the
// address against the rules in tiles.ts before keeping it. Where the backend does not remember preferences
// (the demo) it says that the choice lasts only until the page is left.
import { useId, useState, type FormEvent } from 'react';
import { Check, Power, RotateCcw } from 'lucide-react';
import { confirm, toast } from '@/app/ui-state';
import { Field, FormError, Notice } from '@/components/field';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FocusMemory } from '@/lib/focus';
import type { TileSettings } from './use-tiles';
import { MAX_ATTRIBUTION, plainAttribution, validateTileTemplate } from './tiles';

export function TilesDialog({ open, onClose, opener, tiles }: { open: boolean; onClose(): void; opener: FocusMemory | null; tiles: TileSettings }) {
  const formId = useId();
  const start = tiles.stored?.mode === 'custom' ? tiles.stored : { url: tiles.operator?.url ?? '', attribution: tiles.operator?.attribution ?? '' };
  const [url, setUrl] = useState(start.url);
  const [attribution, setAttribution] = useState(start.attribution);
  const [tried, setTried] = useState(false);

  const check = validateTileTemplate(url);
  const credit = plainAttribution(attribution);
  const urlError = tried && !check.ok ? check.message : '';
  const creditError = tried && !credit ? 'Add the credit the tile provider asks for. It is shown on the map whenever its pictures are.' : '';
  const { config } = tiles;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!check.ok || !credit) return;
    // A server that has not been used yet is asked about first. Changing only the credit line is not a new server.
    if (config?.host !== check.host && !(await confirm({
      title: `Load map pictures from ${check.host}?`,
      message: `Your browser will ask ${check.host} for every map picture. That server will see your IP address, your browser, and which part of the world you are looking at. Nothing about your saves is sent. You can turn tiles off here at any time.`,
      confirmLabel: 'Use these tiles',
    }))) return;
    tiles.save({ mode: 'custom', url: check.url, attribution: credit });
    toast('Map tiles are on.');
    onClose();
  };

  const off = () => {
    // With no operator default, "off" and "never chosen" are the same, so nothing is kept.
    tiles.save(tiles.operator ? { mode: 'off' } : null);
    toast('Map tiles are off. The map is a plain sheet again.');
    onClose();
  };

  const useDefault = () => {
    tiles.save(null);
    toast('Using the default map tiles.');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      opener={opener}
      title="Map tiles"
      description="Choose where the map gets its pictures, or leave it a plain sheet."
      footer={(
        <>
          {config ? <Button variant="ghost" className="me-auto" onClick={off}><Power />Turn tiles off</Button> : null}
          {tiles.operator && tiles.stored ? <Button variant="ghost" onClick={useDefault}><RotateCcw />Use the default</Button> : null}
          <Button type="submit" form={formId} variant="primary"><Check />Use these tiles</Button>
        </>
      )}
    >
      <Notice tone={config ? 'sage' : 'plain'} role="status">
        {config ? (
          <>
            <strong className="font-semibold">Tiles are on.</strong>{' '}
            <span dir="auto">The map asks <span className="num">{config.host}</span> for its pictures. {config.source === 'operator' ? 'This is the default this installation was built with.' : 'You chose it.'}</span>
          </>
        ) : (
          <>
            <strong className="font-semibold">Tiles are off.</strong> The map is a plain sheet, and nothing is requested from anywhere.
          </>
        )}
      </Notice>

      <div className="mt-5 flex flex-col gap-3 text-sm leading-relaxed text-ink-soft">
        <p>Map pictures (tiles) come from a tile server, not from your library. When tiles are on, your browser asks that server for each picture, so the server learns your IP address, your browser, and roughly where on the earth you are looking. It never learns what you saved.</p>
        <p>If you run a tile server of your own, point this at it.</p>
      </div>

      <form id={formId} noValidate onSubmit={event => void submit(event)} className="mt-5 flex flex-col gap-4">
        <Field label="Tile address" help="Use {z}, {x} and {y} where the zoom and the tile’s place go, for example https://tiles.example.org/{z}/{x}/{y}.png. Only https, or http for a server on this machine (localhost).">
          <Input
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder="https://tiles.example.org/{z}/{x}/{y}.png"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            maxLength={2048}
            aria-invalid={Boolean(urlError) || undefined}
          />
        </Field>
        <FormError message={urlError} />
        {check.ok && check.warnings.length ? <Notice tone="petal" role="note">{check.warnings.map(warning => <p key={warning}>{warning}</p>)}</Notice> : null}

        <Field label="Credit line" help="The attribution the provider asks for, as plain text. It is shown on the map.">
          <Input value={attribution} onChange={event => setAttribution(event.target.value)} placeholder="© OpenStreetMap contributors" dir="auto" maxLength={MAX_ATTRIBUTION} aria-invalid={Boolean(creditError) || undefined} />
        </Field>
        <FormError message={creditError} />
        <button type="submit" hidden />
      </form>

      <p className="mt-5 text-xs leading-relaxed text-ink-soft">
        {tiles.remembers
          ? 'Your choice is kept in this browser only. It is never sent to your Little Archive server.'
          : 'This demo remembers nothing: your choice lasts until you leave the page.'}
      </p>
    </Modal>
  );
}
