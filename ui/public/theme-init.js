// Runs before first paint so the page never flashes the wrong theme. Kept as a file (not inline) because the
// server's Content-Security-Policy allows scripts from 'self' only. The demo remembers nothing.
(function () {
  var root = document.documentElement;
  var choice = 'system';
  try { if (root.dataset.demo !== 'true') choice = localStorage.getItem('little-archive-theme') || 'system'; } catch (error) { choice = 'system'; }
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
})();
