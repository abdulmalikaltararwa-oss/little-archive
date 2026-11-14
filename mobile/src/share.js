// Links shared into the app from the system share sheet.
//
// The native side (ShareInbox, in the iOS and Android projects) keeps the most recent share until the app asks for it.
// The app takes it only when something is ready to show it, then hands it to the interface, which runs it through the
// same parser as a browser share (parseSharedContent in web/utils.js) and opens the ordinary save dialog. Nothing is
// saved until the person taps Save. The text is untrusted: it only ever fills form fields.

const LIMIT = 20_000;
const text = value => (typeof value === 'string' ? value.slice(0, LIMIT) : '');

export function cleanShare(item) {
  if (!item || typeof item !== 'object') return null;
  const share = { title: text(item.title), text: text(item.text), url: text(item.url) };
  return share.title || share.text || share.url ? share : null;
}

/**
 * @param {{take(): Promise<{items: object[]}>, addListener(name: string, handler: Function): any}} plugin  ShareInbox
 * @param {{addListener(name: string, handler: Function): any}} App  @capacitor/app
 */
export function createShareInbox({ plugin, App }) {
  const handlers = new Set();
  let listening = false;

  async function take() {
    try {
      const { items } = await plugin.take();
      return (Array.isArray(items) ? items : []).map(cleanShare).filter(Boolean);
    } catch { return []; }
  }

  async function deliver() {
    // With nobody to show it to, a share stays where it is: it is not taken and dropped.
    if (!handlers.size) return;
    const latest = (await take()).at(-1);
    if (latest) for (const handler of handlers) handler(latest);
  }

  return {
    /** What was shared before the interface was ready (the app was opened from the share sheet). */
    async initial() { return (await take()).at(-1) ?? null; },
    subscribe(handler) {
      handlers.add(handler);
      if (!listening) {
        listening = true;
        App.addListener('resume', deliver);
        App.addListener('appUrlOpen', deliver);
        plugin.addListener('shareReceived', deliver);
      }
      deliver();
      return () => handlers.delete(handler);
    },
  };
}
