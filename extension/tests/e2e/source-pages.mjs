// Handwritten, synthetic DOM fixtures. No saved-post/account data is copied
// from any real page. The 21-card fixture preserves only observed structure:
// main[role=main], post links containing img[alt], and no figcaptions.
const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function shell(body, script='') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Synthetic saved-view fixture</title>
    <style>body{margin:0;font:16px system-ui}main{padding:20px;min-height:1400px}a{display:block;min-height:36px}img{width:24px;height:24px}h2{font-size:18px}</style>
    </head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function instagramCards(start, count, creator=null) {
  return Array.from({length:count}, (_,offset) => {
    const i=start+offset;
    const kind=['p','reel','reels'][i%3];
    return `<a href="/${creator ? escapeHTML(creator)+'/' : ''}${kind}/CI_SYNTHETIC_${String(i).padStart(5,'0')}/?igsh=fixture"><img src="${pixel}" alt="Synthetic saved image ${i}"></a>`;
  }).join('');
}

export function instagramPage({count=21, startIndex=0, appendOnScroll=0, end=true, login=false, heading=null, extraHeading=null, creator=null}={}) {
  const marker='<p role="status" data-fixture-end>End of saved posts</p>';
  const body=`<main role="main">${login ? '<form><label>Fixture password<input type="password"></label></form>' : ''}
    ${heading ? `<h3>${escapeHTML(heading)}</h3>` : ''}${extraHeading ? `<h3>${escapeHTML(extraHeading)}</h3>` : ''}
    <section id="saved-grid">${instagramCards(startIndex,count,creator)}</section>
    ${end && !appendOnScroll ? marker : ''}<div style="height:1200px" aria-hidden="true"></div></main>`;
  const script=appendOnScroll ? `window.addEventListener('scroll', () => {
    document.getElementById('saved-grid').insertAdjacentHTML('beforeend', ${JSON.stringify(instagramCards(startIndex+count,appendOnScroll,creator))});
    ${end ? `document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(marker)});` : ''}
  }, {once:true});` : '';
  return shell(body,script);
}

export function instagramVirtualizedPage({knownCount=12}={}) {
  const cards=Array.from({length:knownCount+1},(_,i)=>instagramCards(i,1));
  return shell(`<main role="main"><section id="saved-grid">${cards[0]}</section>
    <div style="height:20000px" aria-hidden="true"></div></main>`,
    `let index=0; const cards=${JSON.stringify(cards)};
    window.addEventListener('scroll',()=>{
      if (index<cards.length-1) document.getElementById('saved-grid').innerHTML=cards[++index];
    });`);
}

export function tiktokPage({selected='Favorites', end=true, videoCaption='A synthetic pottery tutorial'}={}) {
  return shell(`<main role="main">
    <div role="tablist"><button role="tab" aria-selected="true">${selected}</button></div>
    <div data-e2e="user-post-item"><a href="/@synthetic_creator/video/1234567890123456789?fixture=1"><img src="${pixel}" alt="Synthetic video cover"></a>
      <span data-e2e="user-post-item-desc">${escapeHTML(videoCaption)}</span></div>
    <div data-e2e="user-post-item"><a href="/@synthetic_creator/photo/2234567890123456789"><img src="${pixel}" alt="Synthetic photo cover"></a>
      <span data-e2e="user-post-item-desc">A synthetic studio inspiration board</span></div>
    <a href="/@synthetic_creator/video/1234567890123456789">Duplicate link to the same synthetic video</a>
    ${end ? '<h2>End of favorites</h2>' : ''}
  </main>`);
}
