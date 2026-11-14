// Runs before first paint so the page never flashes the wrong theme. Kept as a file (not inline) because the
// server's Content-Security-Policy allows scripts from 'self' only. The demo remembers nothing.
(function () {
  // The server puts a nonce on each page it serves. The dialog library adds one <style> element for scroll locking
  // and reads the nonce for it from this global. Without a nonce (the demo, the phone app) nothing is set.
  var meta = document.querySelector('meta[property="csp-nonce"]');
  var nonce = meta && (meta.nonce || meta.getAttribute('nonce'));
  if (nonce) window.__webpack_nonce__ = nonce;
  var root = document.documentElement;
  var choice = 'system';
  try { if (root.dataset.demo !== 'true') choice = localStorage.getItem('little-archive-theme') || 'system'; } catch (error) { choice = 'system'; }
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
})();
