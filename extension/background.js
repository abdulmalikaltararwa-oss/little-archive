import {
  STORAGE_KEY, initialState, normalizeServerURL, permissionPattern, normalizeAccount,
  sourceContext, assertSource, queueObservations, publicState, byteLength, MAX_STATE_BYTES,
} from './core.js';
import {visibleCollectionName} from './page-context.js';

const RETRY_ALARM = 'little-archive-retry';
const LIVE_STATES = new Set(['running','paused','finishing']);
let operation = Promise.resolve();
let flushing = false;
const serial = task => {
  const result = operation.then(task, task);
  operation = result.catch(() => {});
  return result;
};
const read = async () => (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || initialState();
const write = async state => {
  if (byteLength(state) > MAX_STATE_BYTES) throw new Error('Local extension storage is full. Finish or forget the current scan.');
  await chrome.storage.local.set({[STORAGE_KEY]:state});
};

class RequestError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

async function request(config, path, body) {
  if (!config?.token) throw new RequestError('Connect your server first.', 401);
  if (!path.startsWith('/api/extension/')) throw new Error('Unsupported extension endpoint.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(normalizeServerURL(config.server) + path, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{Authorization:`Bearer ${config.token}`, ...(body === undefined ? {} : {'Content-Type':'application/json'})},
      body:body === undefined ? undefined : JSON.stringify(body),
      credentials:'omit', cache:'no-store', redirect:'error', signal:controller.signal,
    });
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new RequestError('The server returned an unexpectedly large response.');
    let data;
    try { data = JSON.parse(raw); } catch { throw new RequestError('The server did not return an API response. Check its address.', response.status); }
    if (!response.ok) {
      const message = typeof data.detail === 'string' ? data.detail.slice(0, 400) : `Server request failed (${response.status}).`;
      throw new RequestError(message, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(error.name === 'AbortError' ? 'The server timed out. Pending batches are saved on this device.' : 'Cannot reach the server. Pending batches are saved on this device.');
  } finally { clearTimeout(timer); }
}

async function verifyInstance(config, expected) {
  const info = await request(config, '/api/extension/status');
  if (!info.ok || typeof info.instance_id !== 'string' || !info.instance_id) throw new Error('This server is not a compatible Little Archive instance.');
  if (expected && info.instance_id !== expected) throw new Error('The server library changed. Forget this scan before connecting to the new instance.');
  return info;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (!tab?.id || !tab.url) throw new Error('Select the source tab, then open Little Archive again.');
  return tab;
}

async function stopTab(run) {
  if (!run?.tabId) return;
  try { await chrome.tabs.sendMessage(run.tabId, {type:'la-stop', runId:run.id}); } catch { /* Page may have closed. Queue remains durable. */ }
}

async function inject(run) {
  const tab = await chrome.tabs.get(run.tabId);
  assertSource(tab.url, run.sourceAccount, run.scopeKey);
  await chrome.scripting.executeScript({target:{tabId:run.tabId}, files:['adapters.js','content.js']});
  const result = await chrome.tabs.sendMessage(run.tabId, {
    type:'la-start',
    run:{id:run.id, platform:run.platform, sourceAccount:run.sourceAccount, scopeKey:run.scopeKey,
      sourceUrl:run.scopeUrl, collection:run.collection, seen:run.seen, confirmed:run.confirmed},
  });
  if (!result?.ok) throw new Error(result?.error || 'The source page could not start the scan.');
}

function staleRun(state) {
  if (state.run?.status === 'running' && Date.now() - state.run.lastHeartbeat > 45000) {
    state.run.status = 'paused';
    state.run.message = 'The page stopped responding or the browser restarted. Reopen the original view and resume.';
    return true;
  }
  return false;
}

async function flushQueue(force = false) {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const keepGoing = await serial(async () => {
        const state = await read();
        if (!state.config || !state.run || !LIVE_STATES.has(state.run.status)) return false;
        const head = state.outbox[0];
        if (!head) {
          if (state.run.status !== 'finishing') return false;
          try {
            await verifyInstance(state.config, state.run.instanceId);
            const result = await request(state.config, `/api/extension/imports/${encodeURIComponent(state.run.id)}/finish`, {
              expected_batches:state.run.nextSequence,
              coverage:state.run.coverage || 'partial',
              reason:(state.run.finishReason || 'User finished this scan.').slice(0,400),
            });
            if (!result.ok) throw new Error('The server did not confirm scan completion.');
            if (['partial','enumeration_exhausted'].includes(result.coverage)) state.run.coverage=result.coverage;
            state.run.status = 'completed';
            state.run.message = state.run.coverage === 'enumeration_exhausted'
              ? 'This view reached an observed end. Review coverage in the app; other collections were not scanned.'
              : 'Partial scan saved. You can import this view again to collect more items.';
            await write(state);
          } catch (error) {
            state.run.message = `Completion pending: ${error.message}`;
            await write(state);
          }
          return false;
        }
        if (!force && (head.blocked || head.nextRetryAt > Date.now())) return false;
        try {
          await verifyInstance(state.config, state.run.instanceId);
          const result = await request(state.config, `/api/extension/imports/${encodeURIComponent(state.run.id)}/batches`, head.body);
          if (result.status !== 'applied') throw new Error('The server did not confirm this batch was applied.');
          state.outbox.shift();
          state.run.appliedBatches += 1;
          state.run.created += Number(result.created) || 0;
          state.run.updated += Number(result.updated) || 0;
          state.run.skipped += Number(result.skipped) || 0;
          await write(state);
          return true;
        } catch (error) {
          head.attempts += 1;
          head.nextRetryAt = Date.now() + Math.min(300000, 3000 * 2 ** Math.min(head.attempts, 7));
          head.blocked = (error.status >= 400 && error.status < 500 && ![408,429].includes(error.status)) || /library changed/.test(error.message);
          state.run.message = error.message;
          if (head.blocked && state.run.status === 'running') state.run.status = 'paused';
          await write(state);
          if (head.blocked) await stopTab(state.run);
          return false;
        }
      });
      if (!keepGoing) break;
      force = false;
    }
  } finally { flushing = false; }
}

async function handlePopup(message) {
  switch (message.type) {
    case 'status': return serial(async () => {
      const state = await read();
      if (staleRun(state)) await write(state);
      return {ok:true, state:publicState(state)};
    });
    case 'context': {
      try {
        const tab = await activeTab();
        const context=sourceContext(tab.url);
        let collectionName=null;
        if (context.isCollection) {
          try {
            const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:visibleCollectionName,args:[context.url]});
            const candidate=results[0]?.result;
            if (typeof candidate==='string' && candidate.trim() && candidate.length<=200) collectionName=candidate;
          } catch { /* Manual exact-name entry remains available on unsupported layouts. */ }
        }
        return {ok:true, context:{...context, collectionName, tabId:tab.id}};
      } catch (error) { return {ok:false, error:error.message}; }
    }
    case 'configure': return serial(async () => {
      const state = await read();
      const server = normalizeServerURL(message.server);
      const granted = await chrome.permissions.contains({origins:[permissionPattern(server)]});
      if (!granted) throw new Error('Grant access to your chosen server before connecting.');
      const token = typeof message.token === 'string' && message.token.trim()
        ? message.token.trim() : (state.config?.server === server ? state.config.token : '');
      if (token.length < 16 || token.length > 512 || /\s/.test(token)) throw new Error('Paste an import token generated in your app settings.');
      if (state.run && LIVE_STATES.has(state.run.status) && state.config?.server !== server) {
        throw new Error('Finish or forget the current scan before switching servers.');
      }
      if (state.run && LIVE_STATES.has(state.run.status) && state.config?.token !== token) {
        throw new Error('Finish or forget the current scan before changing its import token. Each scan is bound to the token that created it.');
      }
      const expected = state.run && LIVE_STATES.has(state.run.status) ? state.run.instanceId : null;
      const info = await verifyInstance({server,token}, expected);
      state.config = {server,token,instance_id:info.instance_id};
      await write(state);
      return {ok:true, state:publicState(state)};
    });
    case 'start': {
      const tab = await activeTab();
      const result = await serial(async () => {
        const state = await read();
        if (!state.config) throw new Error('Connect your server first.');
        if (state.run && LIVE_STATES.has(state.run.status)) throw new Error('Finish or forget the existing scan before starting another.');
        if (message.confirmed !== true) throw new Error('Confirm this is your Saved or Favorites view before importing.');
        const account = normalizeAccount(message.sourceAccount);
        const context = assertSource(tab.url, account);
        const name = typeof message.collectionName === 'string' ? message.collectionName : '';
        if (name.length > 200) throw new Error('The collection name must be at most 200 characters.');
        if (context.isCollection && !name.trim()) throw new Error('Enter the exact source collection name.');
        if (!context.isCollection && name) throw new Error('Leave the collection name empty for All posts or Favorites.');
        const info = await verifyInstance(state.config, state.config.instance_id);
        const source = await request(state.config, '/api/extension/imports', {
          platform:context.platform, source_account:account,
          scope:context.isCollection ? name : (context.platform === 'instagram' ? 'All posts' : 'Favorites'),
        });
        if (typeof source.run_id !== 'string' || source.instance_id !== info.instance_id) throw new Error('The server returned an invalid import identity.');
        state.run = {
          id:source.run_id, instanceId:info.instance_id, platform:context.platform, sourceAccount:account,
          scopeUrl:context.url, scopeKey:context.scopeKey, tabId:tab.id,
          collection:context.isCollection ? {source_key:context.scopeKey,name} : null,
          confirmed:true, status:'running', discovered:0, created:0, updated:0, skipped:0,
          appliedBatches:0, nextSequence:0, seen:[], scrolls:0, coverage:'partial',
          startedAt:Date.now(), lastHeartbeat:Date.now(), message:'Reading the current source view…',
        };
        state.outbox = [];
        await write(state);
        return state.run;
      });
      try { await inject(result); }
      catch (error) {
        await serial(async () => { const state = await read(); if (state.run?.id === result.id) { state.run.status='paused'; state.run.message=error.message; await write(state); } });
        throw error;
      }
      return {ok:true};
    }
    case 'pause': {
      const run = await serial(async () => {
        const state = await read();
        if (state.run?.status === 'running') { state.run.status='paused'; state.run.message='Paused. Pending batches can still finish uploading.'; await write(state); }
        return state.run;
      });
      await stopTab(run);
      return {ok:true};
    }
    case 'resume': {
      const tab = await activeTab();
      const run = await serial(async () => {
        const state = await read();
        if (!state.run || !['paused','running'].includes(state.run.status)) throw new Error('There is no paused scan to resume.');
        assertSource(tab.url, state.run.sourceAccount, state.run.scopeKey);
        await verifyInstance(state.config, state.run.instanceId);
        state.run.tabId=tab.id; state.run.status='running'; state.run.lastHeartbeat=Date.now();
        state.run.message='Resuming this view. Existing post identifiers will be skipped.';
        state.outbox.forEach(entry => { entry.blocked=false; entry.nextRetryAt=0; });
        await write(state); return state.run;
      });
      try { await inject(run); }
      catch (error) {
        await serial(async () => { const state=await read(); if (state.run?.id===run.id) {state.run.status='paused'; state.run.message=error.message; await write(state);} });
        throw error;
      }
      void flushQueue(true);
      return {ok:true};
    }
    case 'finish': {
      const run = await serial(async () => {
        const state=await read();
        if (!state.run || !LIVE_STATES.has(state.run.status)) throw new Error('There is no current scan to finish.');
        state.run.status='finishing'; state.run.coverage='partial'; state.run.finishReason='User finished a partial current-view scan.';
        state.run.message='Applying pending batches, then recording partial coverage…';
        await write(state); return state.run;
      });
      await stopTab(run); void flushQueue(true); return {ok:true};
    }
    case 'retry': {
      await serial(async () => { const state=await read(); state.outbox.forEach(entry => { entry.blocked=false; entry.nextRetryAt=0; }); await write(state); });
      void flushQueue(true); return {ok:true};
    }
    case 'forget': {
      const run=await serial(async () => { const state=await read(); const previous=state.run; state.run=null; state.outbox=[]; await write(state); return previous; });
      await stopTab(run); return {ok:true};
    }
    case 'disconnect': {
      const previous=await serial(async () => { const state=await read(); await write(initialState()); return state; });
      await stopTab(previous.run);
      if (previous.config) await chrome.permissions.remove({origins:[permissionPattern(previous.config.server)]});
      return {ok:true};
    }
    case 'open-app': {
      const state=await read();
      if (!state.config) throw new Error('Connect your server first.');
      await chrome.tabs.create({url:normalizeServerURL(state.config.server)}); return {ok:true};
    }
    default: throw new Error('Unsupported popup command.');
  }
}

async function handleContent(message, sender) {
  const result=await serial(async () => {
    let state=await read();
    const run=state.run;
    if (!run || message.runId !== run.id || sender.tab?.id !== run.tabId || sender.frameId !== 0) throw new Error('This page is not bound to the current scan.');
    assertSource(sender.url, run.sourceAccount, run.scopeKey);
    if (run.status !== 'running') return {ok:false,error:'The scan has paused.',paused:true};
    if (message.type === 'capture') {
      if (!Array.isArray(message.items) || message.items.length > 50) throw new Error('Invalid capture batch.');
      try { state=queueObservations(state,message.items).state; }
      catch (error) { state.run.status='paused'; state.run.message=error.message; await write(state); return {ok:false,error:error.message,paused:true}; }
      state.run.lastHeartbeat=Date.now();
      state.run.scrolls=Math.max(0,Math.min(100000,Number(message.scrolls)||0));
      if (!state.outbox.some(entry => entry.attempts)) state.run.message='Scanning this view. Keep the source tab open.';
      await write(state);
      return {ok:true};
    }
    if (message.type === 'scan-paused') {
      run.status='paused'; run.message=String(message.reason || 'Scan paused.').slice(0,400); await write(state); return {ok:true};
    }
    if (message.type === 'scan-finished') {
      run.status='finishing'; run.coverage=message.coverage==='enumeration_exhausted' ? 'enumeration_exhausted' : 'partial';
      run.finishReason=String(message.reason || 'Current-view traversal stopped.').slice(0,400);
      run.message='Applying pending batches…'; await write(state); return {ok:true};
    }
    throw new Error('Unsupported page message.');
  });
  void flushQueue();
  return result;
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const trustedPopup=!sender.tab && typeof sender.url==='string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const fromPage=Boolean(sender.tab) && ['capture','scan-paused','scan-finished'].includes(message.type);
  if (!trustedPopup && !fromPage) { sendResponse({ok:false,error:'Untrusted extension message.'}); return false; }
  (trustedPopup ? handlePopup(message) : handleContent(message,sender))
    .then(sendResponse).catch(error => sendResponse({ok:false,error:error.message || 'Operation failed.'}));
  return true;
});

async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await chrome.alarms.create(RETRY_ALARM,{periodInMinutes:1});
  await serial(async () => { const state=await read(); if (staleRun(state)) await write(state); });
  void flushQueue();
}
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name===RETRY_ALARM) {
    void serial(async () => { const state=await read(); if (staleRun(state)) await write(state); }).then(() => flushQueue());
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serial(async () => { const state=await read(); if (state.run?.tabId===tabId && state.run.status==='running') { state.run.status='paused'; state.run.message='Source tab closed. Reopen the same view and resume.'; await write(state); } });
});
void initialize();
