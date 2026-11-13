import {normalizeServerURL,permissionPattern} from './core.js';

const $=id => document.getElementById(id);
let state=null;
let context=null;
let busy=false;
let refreshing=false;

async function message(payload) {
  const response=await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || 'The extension is not responding. Close and reopen this popup.');
  return response;
}
function notice(text,error=false) {
  $('notice').textContent=text; $('notice').classList.toggle('error',error); $('notice').hidden=!text;
}
function render() {
  const connected=Boolean(state?.config);
  const run=state?.run;
  const active=run && ['running','paused','finishing'].includes(run.status);
  $('connection-dot').classList.toggle('connected',connected);
  $('connection-label').textContent=connected ? new URL(state.config.server).host : 'Not connected';
  $('open-app').disabled=!connected;
  $('disconnect').disabled=!connected || busy;
  $('start').disabled=busy || !connected || !context || context.isIndex || Boolean(active);
  $('account').disabled=Boolean(active);
  $('collection').disabled=Boolean(active);
  $('confirm-view').disabled=Boolean(active);
  $('run-panel').hidden=!run;
  if (run) {
    $('run-state').textContent=run.status[0].toUpperCase()+run.status.slice(1);
    $('run-scope').textContent=`${run.platform==='instagram'?'Instagram':'TikTok'} · @${run.sourceAccount} · ${run.collectionName || (run.platform==='instagram'?'All posts':'Favorites')}`;
    $('observed').textContent=run.discovered.toLocaleString();
    $('applied').textContent=(run.created+run.updated+run.skipped).toLocaleString();
    $('pending').textContent=run.pendingItems.toLocaleString();
    $('run-message').textContent=run.message;
    $('pause').hidden=run.status!=='running';
    $('resume').hidden=run.status!=='paused';
    $('finish').hidden=!['running','paused'].includes(run.status);
    $('retry').hidden=!run.pendingBatches && run.status!=='finishing';
    for (const id of ['pause','resume','finish','retry','forget']) $(id).disabled=busy;
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing=true;
  try { state=(await message({type:'status'})).state; render(); }
  catch (error) { notice(error.message,true); }
  finally { refreshing=false; }
}

async function action(type) {
  if (busy) return;
  busy=true; notice(''); render();
  try { await message({type}); await refresh(); }
  catch (error) { notice(error.message,true); }
  finally { busy=false; render(); }
}

$('setup-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (busy) return;
  let server;
  try { server=normalizeServerURL($('server').value); }
  catch (error) { notice(error.message,true); return; }
  // Permission request stays directly in this user gesture, before other async work.
  let granted;
  try { granted=await chrome.permissions.request({origins:[permissionPattern(server)]}); }
  catch { notice('Chrome could not grant access to that server host. Check the URL and extension permissions.',true); return; }
  if (!granted) { notice('Server access was not granted. No connection was changed.',true); return; }
  busy=true; render(); notice('Connecting to your server…');
  try {
    const result=await message({type:'configure',server,token:$('token').value});
    state=result.state; $('server').value=server; $('token').value=''; $('setup').open=false;
    notice('Connected. Your import token stays in this browser profile.');
  } catch (error) {
    if (state?.config?.server!==server) {
      try { await chrome.permissions.remove({origins:[permissionPattern(server)]}); } catch { /* Chrome settings can remove a failed setup grant. */ }
    }
    notice(error.message,true);
  }
  finally { busy=false; render(); }
});

$('start-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (busy) return;
  if (!$('confirm-view').checked) { notice('Confirm the current Saved or Favorites view before importing.',true); return; }
  busy=true; render(); notice('Starting the current-view import…');
  try {
    await message({type:'start',sourceAccount:$('account').value,collectionName:context?.isCollection ? $('collection').value : '',confirmed:true});
    notice('Scan started. Keep the source tab open; this popup can close.'); await refresh();
  } catch (error) { notice(error.message,true); }
  finally { busy=false; render(); }
});

for (const id of ['pause','resume','finish','retry']) $(id).addEventListener('click',()=>action(id));
$('forget').addEventListener('click',() => {
  if (confirm('Forget this device’s scan checkpoint and any unsent batches? Records already processed by the server stay in your library. The server may retain an unfinished import entry.')) void action('forget');
});
$('disconnect').addEventListener('click',async () => {
  if (!confirm('Disconnect and remove this device’s token, checkpoint, and pending batches? To revoke the token itself, also remove it in your app settings.')) return;
  await action('disconnect'); $('token').value=''; $('setup').open=true;
});
$('open-app').addEventListener('click',()=>action('open-app'));

async function initialize() {
  await refresh();
  if (state?.config) $('server').value=state.config.server;
  else { $('server').value='http://localhost:8787'; $('setup').open=true; }
  try {
    const response=await message({type:'context'}); context=response.context;
    $('platform-label').textContent=context.platform==='instagram'?'INSTAGRAM SAVED VIEW':'TIKTOK FAVORITES VIEW';
    $('source-title').textContent=context.isCollection?'Import this collection':'Import this saved view';
    $('account').value=context.account;
    $('collection-field').hidden=!context.isCollection;
    $('collection').required=context.isCollection;
    $('context-help').textContent=context.isIndex
      ? 'Open All posts or an individual collection in Instagram, then reopen this popup.'
      : context.isCollection
        ? 'Only the current collection will be scanned. Copy its exact name below to preserve the membership.'
        : 'Only this view will be scanned. Import individual collections separately to preserve their memberships.';
  } catch (error) { $('context-help').textContent=error.message; }
  render();
  setInterval(()=>{void refresh();},1500);
}
void initialize();
