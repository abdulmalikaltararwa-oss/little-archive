// The server marks each page it serves with a nonce (see server/webui.py), so the few <style> elements that
// libraries add at run time can be allowed one by one instead of allowing every inline style. Where there is
// no nonce (the demo page, the phone app, the dev server) this is undefined and nothing changes.
export function cspNonce(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const meta = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
  // The attribute's value is hidden from script once the page is parsed; the property keeps it.
  return meta?.nonce || meta?.getAttribute('nonce') || undefined;
}
