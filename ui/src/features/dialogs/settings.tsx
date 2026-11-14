// Make yourself at home: appearance, previews and privacy, browser connections, AI, your data, and (inside
// the app) this device's account.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { errorMessage, formatDate } from '@web/utils.js';
import { Activity, Archive, ArrowRight, Check, Copy, Download, KeyRound, LogOut, Monitor, Moon, Plus, RotateCcw, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { useArchive, useArchiveState, useBusy } from '@/app/archive-context';
import { useTheme, type Theme } from '@/app/theme';
import { confirm, openDialog, toast } from '@/app/ui-state';
import { Field, FormError, Notice, Section } from '@/components/field';
import { Modal } from '@/components/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { ExtensionToken } from '@/data/types';
import { copyText, downloadFile } from '../actions';
import type { DialogProps } from './basic';

function Connections() {
  const archive = useArchive();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [creating, setCreating] = useState(false);
  const [tokens, setTokens] = useState<ExtensionToken[] | null>(null);
  const [fresh, setFresh] = useState('');

  const [version, setVersion] = useState(0);
  const refresh = () => setVersion(value => value + 1);
  useEffect(() => {
    let stale = false;
    archive.api.tokens().then(
      result => { if (!stale) { setTokens(result.tokens || []); setListError(''); } },
      caught => { if (!stale) setListError(errorMessage(caught)); },
    );
    return () => { stale = true; };
  }, [archive, version]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setCreating(true);
    try {
      const result = await archive.api.createToken(name.trim());
      setFresh(result.token);
      setName('');
      refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  };

  const revoke = (token: ExtensionToken) => confirm({
    title: 'Revoke this connection?',
    message: 'This browser connection will no longer be able to import. Existing saved items remain in your archive.',
    action: async () => {
      await archive.api.revokeToken(token.id);
      refresh();
      toast('Connection revoked.');
    },
  });

  return (
    <>
      <p>Create an import-only token, then enter it and this server address in the companion extension. Tokens can import records but cannot read your library or change your notes.</p>
      <Notice>
        <strong className="font-semibold">Server address</strong>
        <p dir="ltr" className="num mt-0.5 break-all text-ink-soft">{archive.backend.serverUrl}</p>
      </Notice>
      <p>Install the extension from the extension folder in the project repository. In Chrome, open Extensions, enable Developer mode, and choose Load unpacked.</p>
      <form noValidate onSubmit={event => void create(event)} className="flex flex-col gap-3">
        <FormError message={error} />
        <Field label="Connection name"><Input required maxLength={80} placeholder="e.g. My laptop" value={name} onChange={event => setName(event.target.value)} /></Field>
        <div><Button type="submit" variant="soft" disabled={creating} aria-busy={creating || undefined}><Plus />Create import token</Button></div>
      </form>
      {fresh ? (
        <div className="flex flex-col gap-2.5 rounded-lg bg-sage-pale p-4">
          <p className="text-xs text-ink">Copy this token now. It is only shown once. Keep it private.</p>
          <Textarea readOnly value={fresh} aria-label="New import token" className="min-h-20 font-mono text-xs" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void copyText(fresh)}><Copy />Copy token</Button>
            <Button variant="ghost" size="sm" onClick={() => setFresh('')}><X />Hide token</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {listError ? <FormError message={listError} /> : null}
        {(tokens || []).map(token => (
          <div key={token.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-4 py-3">
            <div className="min-w-0">
              <strong dir="auto" className="block truncate text-sm font-semibold text-ink">{token.name}</strong>
              <p className="text-xs">{token.last_used_at ? `Last used ${formatDate(token.last_used_at)}` : `Created ${formatDate(token.created_at)} · not used yet`}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void revoke(token)}><X />Revoke</Button>
          </div>
        ))}
        {tokens && !tokens.length ? <p className="text-xs">No browser connections yet.</p> : null}
      </div>
    </>
  );
}

function AccountSection() {
  const archive = useArchive();
  const account = archive.backend.account;
  if (!account) return null;
  const hosted = archive.backend.mode === 'hosted';
  const leave = (title: string, message: string, action: () => Promise<void> | void) => confirm({ title, message, action });
  return (
    <Section title="This device" id="settings-account">
      <p>{hosted ? `Signed in to a Little Archive account${account.email ? ` as ${account.email}` : ''}.` : 'Signed in to your own server.'}</p>
      {hosted ? null : (
        <Notice>
          <strong className="font-semibold">Server address</strong>
          <p dir="ltr" className="num mt-0.5 break-all text-ink-soft">{archive.backend.serverUrl}</p>
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => void leave('Sign out of this device?', hosted ? 'Your library stays in your account. Sign in again to open it.' : 'This device’s access to your server is ended. Your library stays on the server.', () => account.signOut())}><LogOut />Sign out</Button>
        <Button variant="ghost" onClick={() => void leave('Switch to another server?', 'You will be signed out of this one and asked where your library lives. Nothing is deleted.', () => account.switchServer())}><ArrowRight />Switch server</Button>
      </div>
      {hosted ? <div><Button variant="danger-ghost" size="sm" className="-ms-2" onClick={() => openDialog({ kind: 'delete-account' })}><Trash2 />Delete my account…</Button></div> : null}
    </Section>
  );
}

export function SettingsDialog({ spec, close }: DialogProps<'settings'>) {
  const archive = useArchive();
  const { backend } = archive;
  const demo = backend.kind === 'demo';
  const settings = useArchiveState(state => state.settings);
  const theme = useTheme(state => state.theme);
  const setTheme = useTheme(state => state.set);
  const previewsId = useId();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [downloading, runDownload] = useBusy();
  const [demoBusy, runDemo] = useBusy();
  const [signOutBusy, runSignOut] = useBusy();
  const connections = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (spec.section !== 'connections') return;
    const timer = setTimeout(() => connections.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    return () => clearTimeout(timer);
  }, [spec.section]);

  const togglePreviews = async (desired: boolean) => {
    if (desired && !(await confirm({
      title: 'Enable remote previews?',
      message: 'Your browser will contact the original media hosts and share the usual network information, such as your IP address. Local uploaded previews do not need this setting.',
      confirmLabel: 'Enable previews',
    }))) return;
    setPreviewBusy(true);
    try {
      archive.setSettings(await archive.api.patchSettings({ remote_previews: desired }));
      toast(desired ? 'Remote previews enabled.' : 'Remote previews disabled.');
    } catch (caught) {
      toast(errorMessage(caught), { error: true });
    } finally {
      setPreviewBusy(false);
    }
  };

  const addDemo = () => runDemo(async () => {
    const result = await archive.api.addDemo();
    await archive.refreshLibrary();
    toast(result.created ? `${result.created} synthetic demo saves added. Enjoy exploring.` : 'Your demo saves are already here.');
  });

  return (
    <Modal
      open={spec.open}
      onClose={close}
      size="lg"
      title="Make yourself at home"
      description="A few preferences for your own little corner of the internet."
      opener={spec.opener}
      footer={<Button variant="primary" onClick={close}><Check />Done</Button>}
    >
      {demo ? (
        <Notice className="mb-5">
          <strong className="font-semibold">Isolated interactive demo</strong>
          <p className="mt-1 text-ink-soft">All content and changes live in memory in this page. No account, server, credentials, imports, AI service, or external media are connected. Reloading resets the demo. Exports contain only the demo records currently in memory.</p>
        </Notice>
      ) : null}

      <Section title="A light that feels right">
        <p>{demo ? 'Appearance resets with the rest of the demo on reload.' : 'Appearance is remembered in this browser.'}</p>
        <Segmented<Theme>
          label="Appearance"
          stretch
          value={theme}
          onValueChange={setTheme}
          options={[{ value: 'light', label: 'Light', icon: <Sun aria-hidden="true" /> }, { value: 'dark', label: 'Dark', icon: <Moon aria-hidden="true" /> }, { value: 'system', label: 'System', icon: <Monitor aria-hidden="true" /> }]}
        />
      </Section>

      <Section title="Previews & privacy">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={previewsId} className="text-sm text-ink">Load remote image previews</label>
          <Switch id={previewsId} checked={Boolean(settings.remote_previews)} disabled={demo || previewBusy} onCheckedChange={next => void togglePreviews(next)} />
        </div>
        <p>{demo ? 'External media requests are disabled in this demo. Every preview is original decorative text artwork.' : 'Off by default. When enabled, your browser contacts the original media host. Local image uploads stay with your instance.'}</p>
      </Section>

      {/* A hosted account has no browser-extension connection: those routes do not exist there. */}
      {backend.mode !== 'hosted' ? (
        <div ref={connections} className="scroll-mt-4">
          <Section title="Connect your browser" id="settings-connections">
            {demo ? <p>Browser connections require your own self-hosted instance. This public demo creates no credentials and cannot import from a real account.</p> : <Connections />}
          </Section>
        </div>
      ) : null}

      <Section title={settings.ai_hosted ? 'Optional hosted AI' : 'Optional local AI'}>
        <p>
          {demo
            ? 'No AI runs in this demo. A self-hosted instance can use an operator-configured local Ollama model to suggest topics from available text.'
            : settings.ai_hosted
              ? `Configured: ${settings.ai_provider} (${settings.ai_model}). Post text (caption, creator, any transcript) is sent to that service to make suggestions, which are yours to review.`
              : settings.ai_enabled
                ? `Configured model: ${settings.ai_model || 'local model'}. Suggestions are created from the available text and are yours to review.`
                : 'No model is configured. To enable suggestions, set your Ollama URL and model (or a hosted provider) in the server environment and restart the instance.'}
        </p>
        <p>A text model cannot watch a video. Imported captions, titles, transcripts of the audio, and image alternative text remain distinct evidence.</p>
        <div><Button size="sm" onClick={() => { close(); openDialog({ kind: 'activity', tab: 'ai' }); }}><Activity />View classification jobs</Button></div>
      </Section>

      <Section title="Your data, ready to go">
        <p>{demo ? 'These downloads contain the synthetic demo records and any in-memory edits you made. They are not a backup of a real account.' : 'JSON preserves your organization and notes. CSV is useful for spreadsheets; HTML works with bookmark managers.'}</p>
        <div className="flex flex-wrap gap-2">
          {([['json', 'JSON'], ['csv', 'CSV'], ['html', 'Bookmarks HTML']] as const).map(([format, label]) => (
            <Button key={format} size="sm" disabled={downloading} onClick={() => void runDownload(() => downloadFile(archive, `/export?format=${format}`, `little-archive.${format}`))}><Download />{label}</Button>
          ))}
        </div>
        <div><Button disabled={demo || downloading} title={demo ? 'Full backups require a self-hosted server.' : undefined} onClick={() => void runDownload(() => downloadFile(archive, '/backup', 'little-archive-backup.zip'))}><Archive />Download full backup</Button></div>
        <p>{demo ? 'A full database-and-assets backup is available in your own instance. This public demo has no database or server to back up.' : 'Backups include a database snapshot and local assets. Restore with the offline server command so pending work and library identity can be handled safely.'}</p>
      </Section>

      <Section title="Take a little look around">
        <p>Add clearly labeled synthetic demo saves to explore the interface. This does not connect a real social account.</p>
        <div><Button size="sm" disabled={demoBusy} aria-busy={demoBusy || undefined} onClick={() => void addDemo()}><Sparkles />Add demo collection</Button></div>
      </Section>

      {/* Seam: the one-time unlock arrives in the next wave. Today the screen only reports what the server says. */}
      <Section title="Unlock">
        <p>Little Archive is free on your own server, always. For the hosted service a one-time unlock is on its way.</p>
        <div><Button variant="ghost" size="sm" className="-ms-2" onClick={() => { close(); archive.navigate({ screen: 'unlock', item: '' }); }}><KeyRound />See what is planned</Button></div>
      </Section>

      <AccountSection />

      <Section title="Little Archive">
        <p>Development toward 1.0 · Open source under the MIT license. Check import activity for observed coverage.</p>
        {demo ? (
          <div><Button variant="ghost" className="-ms-2" onClick={() => location.reload()}><RotateCcw />Reset demo</Button></div>
        ) : backend.account ? null : (
          <div>
            <Button variant="ghost" className="-ms-2" disabled={signOutBusy} aria-busy={signOutBusy || undefined} onClick={() => void runSignOut(async () => { await archive.logout(); close(); })}><LogOut />Sign out</Button>
          </div>
        )}
      </Section>
    </Modal>
  );
}
