(() => {
  if (window.__littleArchiveScanner) return;
  let session=null;
  const sleep=ms => new Promise(resolve => setTimeout(resolve,ms));

  function badge(run) {
    const host=document.createElement('div');
    host.setAttribute('data-little-archive','scanner');
    const shadow=host.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:system-ui,sans-serif;color:#292d2a}section{background:#f7f4ef;border:1px solid #d8d6cf;border-radius:18px;box-shadow:0 8px 36px #0002;padding:15px 17px;width:260px}strong{font-size:14px}p{font-size:12px;line-height:1.5;margin:7px 0 11px;overflow-wrap:anywhere}button{background:#48654c;color:white;border:0;border-radius:9px;padding:7px 12px;font:600 12px system-ui;cursor:pointer}button:disabled{opacity:.6}span{display:inline-block;margin-left:8px;font-size:11px;color:#667067}';
    const section=document.createElement('section');
    section.setAttribute('aria-label','Little Archive import status');
    const title=document.createElement('strong'); title.textContent='Little Archive';
    const info=document.createElement('p'); info.textContent='Reading this saved view…'; info.setAttribute('role','status');
    const pause=document.createElement('button'); pause.type='button'; pause.textContent='Pause';
    const label=document.createElement('span'); label.textContent='Current view only';
    pause.addEventListener('click',() => {
      if (session?.run.id!==run.id) return;
      session.cancelled=true; pause.disabled=true; info.textContent='Paused. Reopen the extension to resume or finish.';
      void chrome.runtime.sendMessage({type:'scan-paused',runId:run.id,reason:'Paused from the source page.'}).catch(() => {});
    });
    section.append(title,info,pause,label); shadow.append(style,section); document.documentElement.append(host);
    return {host,info,pause};
  }

  async function send(current,type,extra={}) {
    const result=await chrome.runtime.sendMessage({type,runId:current.run.id,...extra});
    if (!result?.ok) throw new Error(result?.error || 'The extension connection was interrupted. Reopen it and resume.');
    return result;
  }

  async function scan(current) {
    let scrolls=0;
    let stagnant=0;
    const started=Date.now();
    const adapter=window.__littleArchiveAdapters;
    try {
      while (!current.cancelled) {
        const root=adapter.inspect(current.run);
        const {records,lastLink}=adapter.collect(root,current.run.platform);
        const fresh=records.filter(item => !current.seen.has(item._key));
        for (let i=0;i<fresh.length && !current.cancelled;i+=50) {
          const group=fresh.slice(i,i+50);
          await send(current,'capture',{items:group.map(({_key,...item})=>item),scrolls});
          group.forEach(item => current.seen.add(item._key));
        }
        if (current.cancelled) break;
        if (!fresh.length) await send(current,'capture',{items:[],scrolls});
        current.ui.info.textContent=`${current.seen.size.toLocaleString()} unique posts observed. Scanning this view only.`;
        stagnant=fresh.length ? 0 : stagnant+1;
        const end=adapter.endStatus(root,records.length);
        if (end) {
          await send(current,'scan-finished',{coverage:'enumeration_exhausted',reason:end==='empty'?'The source displayed an explicit empty saved-view state.':'The source displayed an explicit end marker.'});
          current.ui.info.textContent=end==='empty'?'The source reports this view is empty.':'Observed end reached. Review import coverage in the app.';
          current.cancelled=true; break;
        }
        if (scrolls>=300 || Date.now()-started>10*60*1000) {
          await send(current,'scan-paused',{reason:'The scan reached its safety limit. Review the source, then resume if more saves remain.'});
          current.ui.info.textContent='Paused at the scan limit. Resume from the extension to continue.';
          current.cancelled=true; break;
        }
        if (stagnant>=8) {
          await send(current,'scan-finished',{coverage:'partial',reason:current.seen.size
            ? 'No new cards appeared after repeated scrolling. No explicit end marker was observed.'
            : 'No supported saved-post links were exposed. The view may be empty, still loading, or unsupported.'});
          current.ui.info.textContent=current.seen.size?'Partial scan saved. No more cards appeared; completeness is unverified.':'No supported cards found. Check the view and its layout.';
          current.cancelled=true; break;
        }
        const scroller=adapter.scrollContainer(root,lastLink);
        scroller.scrollBy({top:Math.max(360,Math.round((scroller.clientHeight || innerHeight)*0.8)),behavior:'auto'});
        scrolls+=1;
        await sleep(1800);
      }
    } catch (error) {
      if (!current.cancelled) {
        current.cancelled=true;
        current.ui.info.textContent=error.message || 'Scan interrupted. Reopen the extension to resume.';
        try { await chrome.runtime.sendMessage({type:'scan-paused',runId:current.run.id,reason:current.ui.info.textContent}); } catch { /* Durable queue survives. */ }
      }
    } finally { current.ui.pause.disabled=true; }
  }

  chrome.runtime.onMessage.addListener((message,sender,reply) => {
    if (sender.id!==chrome.runtime.id || !message) return false;
    if (message.type==='la-stop') {
      if (session?.run.id===message.runId) {
        session.cancelled=true; session.ui.pause.disabled=true;
        session.ui.info.textContent='Collection stopped. Open Little Archive to review or resume.';
      }
      reply({ok:true}); return false;
    }
    if (message.type!=='la-start') return false;
    try {
      const run=message.run;
      if (!run || typeof run.id!=='string' || !Array.isArray(run.seen)) throw new Error('Invalid import configuration.');
      window.__littleArchiveAdapters.inspect(run);
      if (session) { session.cancelled=true; session.ui.host.remove(); }
      session={run,cancelled:false,seen:new Set(run.seen),ui:badge(run)};
      void scan(session); reply({ok:true});
    } catch (error) { reply({ok:false,error:error.message}); }
    return false;
  });
  window.__littleArchiveScanner={installed:true};
})();
