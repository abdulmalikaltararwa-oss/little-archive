import {test as base, chromium, expect, request} from '@playwright/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createFaultProxy} from './fault-proxy.mjs';
import {PopupDriver} from './popup-driver.mjs';
import {tabTargetForPage} from './target-selection.mjs';

const extensionPath=fileURLToPath(new URL('../..',import.meta.url));
const storageKey='littleArchiveState';

async function jsonResponse(response,label) {
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}.`);
  return response.json();
}

export const test=base.extend({
  owner:[async ({},use) => {
    const baseURL=process.env.LA_E2E_BASE_URL;
    const password=process.env.LA_E2E_OWNER_PASSWORD;
    if (!baseURL || !password || !process.env.LA_E2E_DATA_DIR) {
      throw new Error('Run through tests/e2e/run.mjs so the server and credentials are disposable.');
    }
    const endpoint=new URL(baseURL);
    if (endpoint.protocol!=='http:' || !['127.0.0.1','localhost'].includes(endpoint.hostname)) {
      throw new Error('Extension tests refuse non-loopback application servers.');
    }
    const api=await request.newContext({baseURL,extraHTTPHeaders:{Origin:baseURL}});
    try {
      const login=await jsonResponse(await api.post('/api/auth/login',{data:{password}}),'Owner login');
      const headers={'X-CSRF-Token':login.csrf_token};
      await use({
        baseURL,
        get:async url => jsonResponse(await api.get(url),'Owner read'),
        post:async (url,data) => jsonResponse(await api.post(url,{headers,data}),'Owner write'),
        patch:async (url,data) => jsonResponse(await api.patch(url,{headers,data}),'Owner update'),
        delete:async url => jsonResponse(await api.delete(url,{headers}),'Owner delete'),
      });
    } finally { await api.dispose(); }
  },{scope:'worker'}],

  rig:async ({owner},use,testInfo) => {
    const profile=await mkdtemp(path.join(tmpdir(),'little-archive-extension-e2e-'));
    const account=`synthetic_${randomUUID().replaceAll('-','').slice(0,16)}`;
    const relay=await createFaultProxy(owner.baseURL);
    let token;
    let context;
    let worker;
    let cdp;
    let extensionId;
    let popup;
    const pages=new Map();
    const blocked=[];
    const pageErrors=[];

    async function launch() {
      context=await chromium.launchPersistentContext(profile,{
        channel:'chromium',
        headless:false,
        viewport:{width:1200,height:900},
        args:[
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          '--enable-unsafe-extension-debugging',
          // A second network boundary: synthetic host navigations are fulfilled
          // by routing; every unresolved external hostname remains unreachable.
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      });
      context.on('page',page => page.on('pageerror',error => pageErrors.push(error.message)));
      await context.route('**/*',async route => {
        const url=new URL(route.request().url());
        if (!['http:','https:'].includes(url.protocol)) return route.continue();
        if (url.origin===relay.origin) return route.continue();
        const html=pages.get(url.href);
        if (route.request().isNavigationRequest() && html!==undefined) {
          return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
        }
        // Fixture HTML contains only inline styles/scripts and data: images.
        // Source APIs, real images and all unexpected web requests fail closed.
        blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
      });
      worker=context.serviceWorkers().find(candidate => candidate.url().endsWith('/background.js'));
      if (!worker) worker=await context.waitForEvent('serviceworker',{
        predicate:candidate => candidate.url().endsWith('/background.js'),
      });
      extensionId=new URL(worker.url()).hostname;
      cdp=await context.browser().newBrowserCDPSession();
    }

    async function safeState() {
      return worker.evaluate(async key => {
        const state=(await chrome.storage.local.get(key))[key];
        if (!state) return {connected:false,run:null,outbox:[]};
        return {
          connected:Boolean(state.config),
          run:state.run,
          outbox:state.outbox,
        };
      },storageKey);
    }

    async function closePopup() {
      if (popup) { await popup.close(); popup=null; }
    }

    async function openPopup(source) {
      await closePopup();
      await source.bringToFront();
      const sourceCDP=await context.newCDPSession(source);
      const {targetInfo}=await sourceCDP.send('Target.getTargetInfo');
      await sourceCDP.detach();
      const {targetInfos}=await cdp.send('Target.getTargets',{
        filter:[{type:'tab',exclude:false},{type:'page',exclude:false},{exclude:true}],
      });
      const tabTarget=tabTargetForPage(targetInfo,targetInfos);
      // Actual toolbar action: Chrome supplies the activeTab grant and the
      // popup's real no-sender.tab runtime identity. No chrome API is mocked.
      await cdp.send('Extensions.triggerAction',{id:extensionId,targetId:tabTarget.targetId});
      let target;
      await expect.poll(async () => {
        const {targetInfos}=await cdp.send('Target.getTargets');
        target=targetInfos.find(info => info.url===`chrome-extension://${extensionId}/popup.html`);
        return Boolean(target);
      },{message:'The real extension action popup should open.'}).toBe(true);
      popup=await PopupDriver.attach(cdp,target.targetId);
      await expect.poll(() => popup.value('account')).toBe(account);
      return popup;
    }

    async function grantServerHost() {
      const manager=await context.newPage();
      try {
        await manager.goto('chrome://extensions');
        // Same Chromium management API used by its Extensions settings page.
        // Grant only the test relay's loopback host. The shipping manifest and
        // permissions.request() implementation remain completely unchanged.
        await manager.evaluate(async id => {
          await chrome.developerPrivate.addHostPermission(id,'http://127.0.0.1/*');
        },extensionId);
      } finally { await manager.close(); }
    }

    const rig={
      owner,account,relay,blocked,
      state:safeState,
      openPopup,
      closePopup,
      async source(url,html) {
        const parsed=new URL(url);
        if (!['www.instagram.com','www.tiktok.com'].includes(parsed.hostname) || parsed.protocol!=='https:') {
          throw new Error('Only the two explicit synthetic source hosts may be routed.');
        }
        pages.set(parsed.href,html);
        const page=await context.newPage();
        await page.goto(parsed.href);
        return page;
      },
      async pair(source) {
        await grantServerHost();
        const view=await openPopup(source);
        await view.fill('server',relay.origin);
        await view.fill('token',token.token);
        await view.submitSetup();
        await expect.poll(() => view.text('connection-label')).toBe(new URL(relay.origin).host);
        // Never put the disposable token into an assertion's received-value
        // diff if the UI accidentally leaves it in the input.
        await expect.poll(async () => await view.value('token')==='').toBe(true);
        return view;
      },
      async start(view,collectionName=null) {
        const previousRunId=(await safeState()).run?.id;
        if (collectionName!==null) await view.fill('collection',collectionName);
        if (!await view.evaluate('document.getElementById("confirm-view").checked')) await view.click('confirm-view');
        await view.click('start');
        // A click dispatches the async submit handler; it does not await the
        // background worker. A previous completed run must never satisfy the
        // next import's completion check while its start is still pending.
        await expect.poll(async () => {
          const run=(await safeState()).run;
          return Boolean(run?.id && run.id!==previousRunId);
        },{message:'Starting an import must persist its new run before completion is checked.'}).toBe(true);
      },
      async items() {
        const result=[];
        for (let offset=0;;offset+=200) {
          const page=await owner.get(`/api/items?limit=200&offset=${offset}`);
          result.push(...page.items.filter(item => item.source_account===account));
          if (offset+page.items.length>=page.total) break;
        }
        return result;
      },
      async imports() {
        return (await owner.get('/api/imports')).imports.filter(run => run.source_account===account);
      },
      async waitCompleted(view) {
        await expect.poll(async () => (await safeState()).run?.status).toBe('completed');
        await expect.poll(() => view.text('run-state')).toBe('Completed');
        expect((await safeState()).outbox).toHaveLength(0);
      },
      async restart() {
        await closePopup();
        await context.close();
        context=null;
        await launch();
      },
    };

    try {
      token=await owner.post('/api/extension/tokens',{name:`Synthetic extension CI ${account}`});
      await launch();
      await use(rig);
      expect(blocked,'Synthetic source pages must not make external requests.').toEqual([]);
      expect(pageErrors,'The packaged extension and source fixtures should not throw page errors.').toEqual([]);
    } finally {
      if (testInfo.status!==testInfo.expectedStatus && context) {
        let snapshot;
        let popupStatus;
        try { snapshot=await safeState(); } catch { snapshot={unavailable:true}; }
        try {
          popupStatus=popup ? await popup.evaluate(`Object.fromEntries(
            ['connection-label','context-help','notice','run-state','run-message'].map(id => [id,document.getElementById(id)?.textContent])
          )`) : null;
        } catch { popupStatus={unavailable:true}; }
        await testInfo.attach('synthetic-extension-diagnostics',{
          contentType:'application/json',
          body:Buffer.from(JSON.stringify({state:snapshot,popup:popupStatus,batches:relay.attempts,blocked,pageErrors},null,2)),
        });
      }
      try {
        await closePopup();
        if (context) await context.close();
      } finally {
        try {
          await relay.close();
          if (token) await owner.delete(`/api/extension/tokens/${token.id}`);
        } finally { await rm(profile,{recursive:true,force:true}); }
      }
    }
  },
});

export {expect};
