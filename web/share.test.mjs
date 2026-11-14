import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_PATH, parseSharedContent, readShareTarget, isTikTokShortLink, safeURL } from './utils.js';

const parse = fields => parseSharedContent(fields);
const BAD_SCHEMES = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com/file', 'intent://scan/#Intent;scheme=zxing;end', 'vbscript:msgbox(1)', 'mailto:someone@example.com', 'tel:+15550100'];

test('Android puts the link inside the text: the link is extracted and the sentence becomes a note', () => {
  const instagram = parse({ text: 'Look at this! https://www.instagram.com/reel/SYNTH123/?igsh=abc123.' });
  assert.deepEqual(instagram, { shared: true, url: 'https://www.instagram.com/reel/SYNTH123/?igsh=abc123', title: '', notes: 'Look at this!' });
  const tiktok = parse({ title: 'Video', text: 'Check out a synthetic video https://vm.tiktok.com/ZMsynthetic/' });
  assert.equal(tiktok.url, 'https://vm.tiktok.com/ZMsynthetic/');
  assert.equal(tiktok.notes, 'Check out a synthetic video');
  assert.equal(isTikTokShortLink(tiktok.url), true);
  assert.equal(isTikTokShortLink('https://www.tiktok.com/@someone/video/7000000000000000000'), false);
  assert.equal(isTikTokShortLink('not a link'), false);
});

test('a browser share carries the page title and address in their own fields', () => {
  assert.deepEqual(parse({ title: 'Weeknight pasta', text: '', url: 'https://example.com/pasta?x=1#top' }), { shared: true, url: 'https://example.com/pasta?x=1#top', title: 'Weeknight pasta', notes: '' });
  // Some apps repeat the title as the text; it is not kept twice.
  assert.equal(parse({ title: 'Weeknight pasta', text: 'Weeknight pasta', url: 'https://example.com/p' }).notes, '');
});

test('the url field wins, then the text, then the title; other links in the text are kept as notes', () => {
  const both = parse({ url: 'https://example.com/chosen', text: 'See https://example.com/chosen and https://other.example/also' });
  assert.equal(both.url, 'https://example.com/chosen');
  assert.equal(both.notes, 'See and https://other.example/also');
  assert.equal(parse({ title: 'https://example.com/in-title', text: 'words only' }).url, 'https://example.com/in-title');
  assert.equal(parse({ title: 'Read https://example.com/a now' }).title, 'Read now');
  assert.equal(parse({ text: 'one https://example.com/first two https://example.org/second' }).url, 'https://example.com/first');
});

test('prose punctuation, quotes and brackets around a link are not part of it', () => {
  for (const [text, expected] of [
    ['Go to https://example.com/a.', 'https://example.com/a'],
    ['Really? https://example.com/b?!', 'https://example.com/b'],
    ['(see https://example.com/c)', 'https://example.com/c'],
    ['"https://example.com/d"', 'https://example.com/d'],
    ['He said “https://example.com/e”, wow', 'https://example.com/e'],
    ['<https://example.com/f>', 'https://example.com/f'],
    ['https://en.wikipedia.org/wiki/Foo_(bar).', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://example.com/g،', 'https://example.com/g'],
    ['https://example.com/h\nnext line', 'https://example.com/h'],
  ]) assert.equal(parse({ text }).url, expected, text);
});

test('only http and https links are accepted, whatever surrounds them', () => {
  for (const hostile of BAD_SCHEMES) {
    for (const fields of [{ url: hostile }, { text: hostile }, { title: hostile }, { text: `look ${hostile} here` }]) {
      const result = parse(fields);
      assert.equal(result.url, '', JSON.stringify(fields));
    }
  }
  // A good link next to a bad one is still found, and the bad one never becomes the link.
  assert.equal(parse({ text: 'javascript:alert(1) https://example.com/ok' }).url, 'https://example.com/ok');
  assert.equal(parse({ url: 'javascript:alert(1)', text: 'https://example.com/ok' }).url, 'https://example.com/ok');
});

test('links with embedded credentials are refused', () => {
  for (const text of ['https://user:password@example.com/', 'https://real.example.com@evil.example/', 'http://admin@example.com/path']) {
    assert.equal(parse({ url: text }).url, '', text);
    assert.equal(parse({ text }).url, '', text);
  }
  assert.equal(parse({ text: 'https://user:pw@evil.example/ then https://example.com/safe' }).url, 'https://example.com/safe');
});

test('hidden, control and direction-changing characters cannot be smuggled into a link', () => {
  for (const hidden of ['\u0000', '\u0001', '\u007F', '\u0085', '\u200B', '\u200D', '\u200E', '\u202E', '\u2066']) {
    const text = `https://example.com/a${hidden}b`;
    assert.equal(parse({ url: text }).url, '', JSON.stringify(text));
    assert.equal(parse({ text }).url, '', JSON.stringify(text));
  }
  assert.equal(parse({ text: 'https://example.com/a\u200Bb then https://example.org/ok' }).url, 'https://example.org/ok');
  // Whitespace ends a link, and what is left of a split host is not a plausible one.
  assert.equal(parse({ url: 'https://exam\tple.com/' }).url, '');
});

test('titles and notes lose control and direction characters but keep real text, emoji and Arabic', () => {
  const result = parse({ title: 'abc\u202Edef\u0000g\nh\u2028i', url: 'https://example.com/', text: 'one\r\ntwo\u0007\n\n\n\nthree\u202Dfour' });
  assert.equal(result.title, 'abcdef g h i');
  assert.equal(result.notes, 'one\ntwo\n\nthreefour');
  const mixed = parse({ title: 'وصفة 🍝 سريعة', url: 'https://example.com/', text: 'شاهد هذا 👨\u200D👩\u200D👧' });
  assert.equal(mixed.title, 'وصفة 🍝 سريعة');
  assert.equal(mixed.notes, 'شاهد هذا 👨\u200D👩\u200D👧');
});

test('links are normalised, internationalised hosts are shown in their safe form, and junk hosts are refused', () => {
  assert.equal(parse({ url: 'HTTPS://EXAMPLE.COM/Path' }).url, 'https://example.com/Path');
  assert.equal(parse({ url: 'https://аpple.com/' }).url, 'https://xn--pple-43d.com/');
  assert.equal(parse({ text: 'https://exa mple.com' }).url, '');
  assert.equal(parse({ url: 'https://' }).url, '');
  assert.equal(parse({ url: 'https://example.com:99999/' }).url, '');
  assert.equal(parse({ text: 'http://[::1]:8080/x' }).url, 'http://[::1]:8080/x');
  assert.equal(parse({ text: 'http://localhost:3000/y' }).url, 'http://localhost:3000/y');
  assert.equal(parse({ text: 'no scheme example.com/path' }).url, '');
});

test('markup in shared text stays text: it never becomes part of a link and is never interpreted here', () => {
  const tail = parse({ text: 'https://example.com/<script>alert(1)</script>' });
  assert.equal(tail.url, 'https://example.com/');
  assert.equal(tail.notes, '<script>alert(1)</script>');
  const attribute = parse({ text: '"><img src=x onerror=alert(1)> https://example.com/ok' });
  assert.equal(attribute.url, 'https://example.com/ok');
  assert.equal(typeof attribute.notes, 'string');
  const title = parse({ title: '<b onmouseover=alert(1)>bold</b>', url: 'https://example.com/' });
  assert.equal(title.title, '<b onmouseover=alert(1)>bold</b>');
  for (const value of [tail, attribute, title]) assert.deepEqual(Object.keys(value).sort(), ['notes', 'shared', 'title', 'url']);
});

test('sizes are bounded and truncation never splits an emoji', () => {
  const long = `https://example.com/${'a'.repeat(5000)}`;
  assert.equal(parse({ url: long }).url, '');
  assert.equal(parse({ url: `https://example.com/${'a'.repeat(4000)}` }).url, `https://example.com/${'a'.repeat(4000)}`);
  const emoji = parse({ title: '\u{1F35D}'.repeat(900), text: '\u{1F35D}'.repeat(9000) });
  assert.equal(Array.from(emoji.title).length, 500);
  assert.equal(Array.from(emoji.notes).length, 4000);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji.title + emoji.notes), false);
  const started = performance.now();
  const huge = 'x'.repeat(3_000_000);
  const result = parse({ title: huge, text: `${huge} https://example.com/late`, url: huge });
  assert.ok(performance.now() - started < 2000, 'bounded work on a huge share');
  assert.equal(result.url, '');
  assert.ok(Array.from(result.notes).length <= 4000 && Array.from(result.title).length <= 500);
});

test('whatever arrives, the result is plain strings and the link is something safeURL would accept', () => {
  const inputs = [undefined, null, 0, {}, [], '\uD800', '\uDC00', 'https://', 'https://\uD800.example/', ')))]]]}}}', 'https://example.com/(((((', '%', '%00', 'http://%00/', 'http://0x7f.1/', 'https://example.com/\u2028x', ...BAD_SCHEMES, 'a'.repeat(100000)];
  for (const a of inputs) for (const b of inputs) {
    const result = parse({ title: a, text: b, url: a });
    for (const key of ['url', 'title', 'notes']) assert.equal(typeof result[key], 'string');
    assert.equal(typeof result.shared, 'boolean');
    if (result.url) {
      assert.equal(safeURL(result.url), result.url);
      assert.ok(['http:', 'https:'].includes(new URL(result.url).protocol));
      assert.ok(result.url.length <= 4096);
      assert.equal(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(result.url), false);
    }
  }
  assert.deepEqual(parseSharedContent(), { shared: false, url: '', title: '', notes: '' });
  assert.deepEqual(parse({}), { shared: false, url: '', title: '', notes: '' });
});

test('only the share path is a share launch, and only its three fields are read', () => {
  assert.equal(SHARE_PATH, '/share');
  assert.equal(readShareTarget({ pathname: '/', search: '?url=https%3A%2F%2Fexample.com%2F' }), null);
  assert.equal(readShareTarget({ pathname: '/share/', search: '?url=https%3A%2F%2Fexample.com%2F' }), null);
  assert.equal(readShareTarget({ pathname: '/api/share', search: '?url=https%3A%2F%2Fexample.com%2F' }), null);
  assert.equal(readShareTarget(null), null);
  const launch = readShareTarget({ pathname: '/share', search: '?title=T&text=hello%20https%3A%2F%2Fexample.com%2Fa&url=&next=https%3A%2F%2Fevil.example%2F&notes=ignored&tags=ignored' });
  assert.deepEqual(launch, { shared: true, url: 'https://example.com/a', title: 'T', notes: 'hello' });
  // The first value of a repeated field is used.
  assert.equal(readShareTarget({ pathname: '/share', search: '?url=https%3A%2F%2Fexample.com%2F1&url=https%3A%2F%2Fexample.com%2F2' }).url, 'https://example.com/1');
  // Visiting the share address with nothing attached is a launch with nothing shared.
  assert.deepEqual(readShareTarget({ pathname: '/share', search: '' }), { shared: false, url: '', title: '', notes: '' });
  assert.deepEqual(readShareTarget({ pathname: '/share', search: '?url=&text=%20%20' }), { shared: false, url: '', title: '', notes: '' });
});
