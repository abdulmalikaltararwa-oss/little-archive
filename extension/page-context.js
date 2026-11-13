// Serialized by chrome.scripting.executeScript into the isolated page world.
// Keep this function self-contained: read only a visible, unambiguous heading,
// never a URL slug, page internals, cookies, or hidden application state.
export function visibleCollectionName(expectedUrl) {
  const current=new URL(location.href);
  const expected=new URL(expectedUrl);
  if (current.origin!==expected.origin || current.pathname.replace(/\/$/,'')!==expected.pathname.replace(/\/$/,'')) return null;
  if (/\/(accounts\/login|login|challenge|checkpoint|captcha)(\/|$)/i.test(current.pathname)) return null;
  if (document.querySelector('input[type="password"], iframe[src*="captcha"], form[action*="/accounts/login"]')) return null;
  const root=document.querySelector('main') || document.querySelector('[role="main"]');
  if (!root) return null;
  const names=new Set();
  for (const heading of root.querySelectorAll('h1,h2,h3')) {
    if (heading.closest('a,article,[data-e2e="user-post-item"],nav,aside,footer,[role="status"]')) continue;
    if (!heading.getClientRects().length) continue;
    let node=heading;
    let visible=true;
    let depth=0;
    while (node) {
      const style=getComputedStyle(node);
      if (style.display==='none' || ['hidden','collapse'].includes(style.visibility) || Number(style.opacity)===0 || depth++>64) {
        visible=false; break;
      }
      node=node.parentElement;
    }
    if (!visible) continue;
    const name=heading.textContent?.trim();
    if (!name || name.length>200) continue;
    names.add(name);
    if (names.size>1) return null;
  }
  return names.size===1 ? [...names][0] : null;
}
