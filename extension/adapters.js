// Current-page DOM adapters. This isolated-world script reads rendered links/text only.
// Source layouts are not stable APIs; unsupported views stop instead of importing a feed.
(() => {
  const trim = (value, limit=12000) => {
    if (typeof value !== 'string') return '';
    let result='';
    // Preserve whole Unicode characters within the UTF-16 field limit.
    for (const character of value.trim()) {
      const point=character.codePointAt(0);
      const safe=point>=0xD800 && point<=0xDFFF ? '\uFFFD' : character;
      if (result.length+safe.length>limit) break;
      result+=safe;
    }
    return result.trim();
  };
  function postURL(value, platform) {
    try {
      const url=new URL(value,location.href);
      if (url.protocol!=='https:' || url.username || url.password) return null;
      if (platform==='instagram' && ['www.instagram.com','instagram.com'].includes(url.hostname)) {
        const match=url.pathname.match(/^\/(?:([a-zA-Z0-9._]{1,30})\/)?(p|reel|reels)\/([a-zA-Z0-9_-]{1,100})\/?$/);
        return match ? {url:`https://www.instagram.com/${match[2]==='p'?'p':'reel'}/${match[3]}/`,key:match[3],...(match[1] ? {creator:'@'+match[1]} : {})} : null;
      }
      if (platform==='tiktok' && ['www.tiktok.com','tiktok.com'].includes(url.hostname)) {
        const match=url.pathname.match(/^\/@([a-zA-Z0-9._]{1,80})\/(video|photo)\/(\d{5,30})\/?$/);
        return match ? {url:`https://www.tiktok.com/@${match[1]}/${match[2]}/${match[3]}`,key:match[3],creator:'@'+match[1]} : null;
      }
    } catch { /* Ignore unsupported and unresolved links. */ }
    return null;
  }

  function inspect(run) {
    const url=new URL(location.href);
    const expected=new URL(run.sourceUrl);
    const instagramView=value => {
      const match=value.pathname.match(/^\/([a-zA-Z0-9._]+)\/saved\/([^/]+)(?:\/(\d{1,30}))?\/?$/);
      if (!match || match[2]==='audio' || (match[3] && match[2]==='all-posts')) return null;
      return {account:match[1].toLowerCase(),identity:match[3] ? `collection:${match[3]}` : `saved:${match[2]}`};
    };
    const currentInstagram=run.platform==='instagram' ? instagramView(url) : null;
    const expectedInstagram=run.platform==='instagram' ? instagramView(expected) : null;
    const samePath=run.platform==='instagram'
      ? currentInstagram && expectedInstagram && currentInstagram.account===expectedInstagram.account && currentInstagram.identity===expectedInstagram.identity
      : url.pathname.replace(/\/$/,'')===expected.pathname.replace(/\/$/,'');
    if (url.origin!==expected.origin || !samePath) {
      throw new Error('The source page changed. Reopen the original saved view and resume.');
    }
    if (/\/(accounts\/login|login|challenge|checkpoint|captcha)(\/|$)/i.test(url.pathname)) {
      throw new Error('Sign in or complete the source prompt yourself, then resume.');
    }
    if (document.querySelector('input[type="password"], iframe[src*="captcha"], form[action*="/accounts/login"]')) {
      throw new Error('A login or verification prompt is open. Complete it yourself before resuming.');
    }
    const root=document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    if (!root) throw new Error('The source page has not loaded. Try again when the saved grid is visible.');
    if (run.platform==='instagram') {
      if (!currentInstagram || currentInstagram.account!==run.sourceAccount) {
        throw new Error('This is not the bound Instagram saved-post view.');
      }
    } else if (run.platform==='tiktok') {
      const match=url.pathname.match(/^\/@([a-zA-Z0-9._]+)(?:\/(favorites|favourites|collection)(?:\/[^/]+)?)?\/?$/);
      if (!match || match[1].toLowerCase()!==run.sourceAccount) throw new Error('This is not the bound TikTok account view.');
      if (!run.collection) {
        const selected=[...document.querySelectorAll('[role="tab"][aria-selected="true"], [data-e2e][aria-selected="true"], [data-e2e][data-state="active"]')];
        const meaningful=selected.map(node => trim(node.textContent,120).toLowerCase()).filter(Boolean);
        const favorite=meaningful.some(label => /^(favorites?|favourites?|saved|المفضلة|المفضّلة|المحفوظات)$/.test(label));
        const other=meaningful.some(label => /^(videos?|posts?|liked|likes|الفيديوهات|المنشورات|الإعجابات)$/.test(label));
        if (!favorite && other) throw new Error('Select the TikTok Favorites tab. This importer does not scan the Posts or Liked tab.');
        if (!favorite && run.confirmed!==true) throw new Error('The Favorites tab cannot be verified on this layout. Confirm the current view in the extension.');
      }
    } else throw new Error('Unsupported source platform.');
    return root;
  }

  function collect(root, platform) {
    const records=[];
    const keys=new Set();
    let lastLink=null;
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (anchor.closest('nav,aside,header,footer,[role="navigation"]')) continue;
      const post=postURL(anchor.href,platform);
      if (!post || keys.has(post.key)) continue;
      keys.add(post.key); lastLink=anchor;
      const card=platform==='tiktok' ? anchor.closest('[data-e2e="user-post-item"]') || anchor : anchor;
      const image=card.querySelector('img');
      const item={url:post.url};
      if (post.creator) item.creator=post.creator;
      if (image) {
        const alt=trim(image.getAttribute('alt'),6000);
        if (alt) item.thumbnail_alt=alt;
        const preview=image.currentSrc || image.src;
        if (preview && preview.startsWith('https://')) item.preview_url=preview;
      }
      // Known caption-like fields only. Alternative text never masquerades as a caption.
      const caption=card.querySelector(platform==='tiktok' ? '[data-e2e="user-post-item-desc"]' : 'figcaption');
      if (caption) {
        const value=trim(caption.textContent);
        if (value) { item.caption=value; item.title=trim(value.split('\n')[0],240); }
      }
      records.push({...item,_key:post.key});
    }
    return {records,lastLink};
  }

  function endStatus(root, count, collectionName='') {
    // Look only at page-level headings/statuses, not arbitrary captions containing these words.
    for (const node of root.querySelectorAll('[role="status"],h1,h2,h3')) {
      if (node.closest('a,article,[data-e2e="user-post-item"],nav,aside')) continue;
      const label=trim(node.textContent,180).toLowerCase();
      // A user may legitimately name a collection "No more posts". Its page
      // title is a category label, not evidence that pagination is exhausted.
      if (/^H[1-3]$/.test(node.tagName || '') && collectionName && label===trim(collectionName,180).toLowerCase()) continue;
      if (/^(you['’]?ve reached the end|no more (posts|videos|items)|end of (saved posts|favorites|favourites))[.!]?$/.test(label)) return 'end';
      if (!count && /^(no saved posts( yet)?|no favorites( yet)?|no favourites( yet)?|nothing saved yet|you haven['’]?t saved anything yet)[.!]?$/.test(label)) return 'empty';
    }
    return null;
  }

  function scrollContainer(root,lastLink) {
    let node=lastLink?.parentElement || root;
    while (node && node!==document.body && node!==document.documentElement) {
      const style=getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight+100) return node;
      node=node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  window.__littleArchiveAdapters={postURL,inspect,collect,endStatus,scrollContainer};
})();
