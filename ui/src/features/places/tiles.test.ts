import { describe, expect, it } from 'vitest';
import { operatorTiles, parseStoredTiles, plainAttribution, resolveTiles, serializeStoredTiles, validateTileTemplate } from './tiles';

const OK = 'https://tiles.example.org/{z}/{x}/{y}.png';

function rejected(input: string): string {
  const check = validateTileTemplate(input);
  if (check.ok) throw new Error(`expected ${input} to be refused`);
  return check.message;
}

describe('validateTileTemplate', () => {
  it('accepts an https template with z, x and y', () => {
    const check = validateTileTemplate(`  ${OK}  `);
    expect(check).toEqual({ ok: true, url: OK, host: 'tiles.example.org', warnings: [] });
  });

  it('accepts the optional {s} subdomain and {r} retina placeholders, and a path before them', () => {
    expect(validateTileTemplate('https://{s}.tile.example.org/styles/paper/{z}/{x}/{y}{r}.png')).toMatchObject({ ok: true, host: '{s}.tile.example.org' });
  });

  it('refuses an empty template', () => {
    expect(rejected('   ')).toMatch(/Enter the address/);
  });

  it('needs all three of z, x and y and says which is missing', () => {
    expect(rejected('https://tiles.example.org/{z}/{x}.png')).toMatch(/\{y\} is missing/);
    expect(rejected('https://tiles.example.org/tiles.png')).toMatch(/\{z\} is missing/);
  });

  it('refuses a placeholder a tile layer cannot fill in, which would throw when a tile loads', () => {
    expect(rejected('https://tiles.example.org/{z}/{x}/{y}/{style}.png')).toMatch(/\{style\}/);
    expect(rejected('https://tiles.example.org/{z}/{x}/{y}/{.png')).toMatch(/stray/);
  });

  it('allows only https, and plain http only on this machine', () => {
    expect(rejected('http://tiles.example.org/{z}/{x}/{y}.png')).toMatch(/Only https/);
    expect(rejected('ftp://tiles.example.org/{z}/{x}/{y}.png')).toMatch(/https/);
    expect(rejected('javascript:alert(1)//{z}/{x}/{y}')).toMatch(/https/);
    expect(rejected('//tiles.example.org/{z}/{x}/{y}.png')).toMatch(/https/);
    for (const host of ['localhost:8080', '127.0.0.1:9000', '[::1]:9000']) {
      const check = validateTileTemplate(`http://${host}/{z}/{x}/{y}.png`);
      expect(check.ok).toBe(true);
      if (check.ok) expect(check.warnings.join(' ')).toMatch(/content policy/);
    }
    expect(rejected('http://localhost.evil.example/{z}/{x}/{y}.png')).toMatch(/Only https/);
    expect(rejected('http://127.0.0.1.evil.example/{z}/{x}/{y}.png')).toMatch(/Only https/);
  });

  it('refuses credentials in the address, including the lookalike that hides the real host after an @', () => {
    expect(rejected('https://user:secret@tiles.example.org/{z}/{x}/{y}.png')).toMatch(/username and password/);
    expect(rejected('https://tiles.example.org@evil.example/{z}/{x}/{y}.png')).toMatch(/username and password/);
  });

  it('refuses spaces, line breaks and over-long addresses', () => {
    expect(rejected('https://tiles.example.org/a b/{z}/{x}/{y}.png')).toMatch(/spaces/);
    expect(rejected('https://tiles.example.org/{z}/{x}/{y}.png\nhttps://evil.example')).toMatch(/spaces or line breaks/);
    expect(rejected(`https://tiles.example.org/${'a'.repeat(2100)}/{z}/{x}/{y}.png`)).toMatch(/too long/);
  });

  it('keeps the placeholders out of the server name', () => {
    expect(rejected('https://{z}.tiles.example.org/{x}/{y}')).toMatch(/not in the name/);
  });

  it('allows a key in the query but says where it goes', () => {
    const check = validateTileTemplate('https://tiles.example.org/{z}/{x}/{y}.png?api_key=abc');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.warnings[0]).toMatch(/looks like a key/);
    const plain = validateTileTemplate('https://tiles.example.org/{z}/{x}/{y}.png?style=paper');
    expect(plain.ok && plain.warnings).toEqual([]);
  });
});

describe('plainAttribution', () => {
  it('keeps the words of a credit line and drops its markup', () => {
    expect(plainAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors')).toBe('© OpenStreetMap contributors');
  });
  it('decodes the common entities and numeric ones, and nothing that is not printable', () => {
    expect(plainAttribution('Tiles &amp; data &#169; 2026 &#x2014; me')).toBe('Tiles & data © 2026 — me');
    expect(plainAttribution('a&#0;b &#1114112; c')).toBe('a&#0;b &#1114112; c');
  });
  it('does not turn encoded markup back into markup: it is only ever shown as text', () => {
    expect(plainAttribution('&lt;img src=x onerror=alert(1)&gt;')).toBe('<img src=x onerror=alert(1)>');
  });
  it('folds whitespace and caps the length', () => {
    expect(plainAttribution('  a \n\n b   c ')).toBe('a b c');
    expect(plainAttribution('x'.repeat(500))).toHaveLength(300);
  });
});

describe('what is in use', () => {
  const env = { url: OK, attribution: '&copy; Example Tiles' };

  it('is off when nobody has named a tile server', () => {
    expect(resolveTiles(null, { url: '', attribution: '' })).toBeNull();
    expect(resolveTiles(null, {})).toBeNull();
  });

  it('uses the operator’s build-time default when the owner has said nothing', () => {
    expect(resolveTiles(null, env)).toEqual({ url: OK, host: 'tiles.example.org', attribution: '© Example Tiles', source: 'operator' });
  });

  it('ignores an operator default that is not a valid template', () => {
    expect(operatorTiles({ url: 'http://tiles.example.org/{z}/{x}/{y}', attribution: 'x' })).toBeNull();
  });

  it('lets the owner turn tiles off even when the operator set a default', () => {
    expect(resolveTiles({ mode: 'off' }, env)).toBeNull();
  });

  it('lets the owner’s own server win over the default', () => {
    const mine = 'https://mine.example.net/{z}/{x}/{y}.png';
    expect(resolveTiles({ mode: 'custom', url: mine, attribution: 'Mine' }, env)).toEqual({ url: mine, host: 'mine.example.net', attribution: 'Mine', source: 'owner' });
  });

  it('shows nothing rather than a bad stored template', () => {
    expect(resolveTiles({ mode: 'custom', url: 'http://evil.example/{z}/{x}/{y}', attribution: '' }, env)).toBeNull();
  });
});

describe('the stored setting', () => {
  it('round-trips', () => {
    const value = { mode: 'custom', url: OK, attribution: 'Example' } as const;
    expect(parseStoredTiles(serializeStoredTiles(value))).toEqual(value);
    expect(parseStoredTiles(serializeStoredTiles({ mode: 'off' }))).toEqual({ mode: 'off' });
  });

  it('is no setting when it is missing, damaged, from another version, or no longer passes the rules', () => {
    expect(parseStoredTiles(null)).toBeNull();
    expect(parseStoredTiles('')).toBeNull();
    expect(parseStoredTiles('{not json')).toBeNull();
    expect(parseStoredTiles('null')).toBeNull();
    expect(parseStoredTiles(JSON.stringify({ v: 2, mode: 'off' }))).toBeNull();
    expect(parseStoredTiles(JSON.stringify({ v: 1, mode: 'custom', url: 'http://tiles.example.org/{z}/{x}/{y}' }))).toBeNull();
    expect(parseStoredTiles(JSON.stringify({ v: 1, mode: 'custom', url: 42 }))).toBeNull();
    expect(parseStoredTiles(JSON.stringify({ v: 1, mode: 'surprise' }))).toBeNull();
  });

  it('cleans an attribution that was written as markup', () => {
    expect(parseStoredTiles(JSON.stringify({ v: 1, mode: 'custom', url: OK, attribution: '<b>Hi</b>' }))).toEqual({ mode: 'custom', url: OK, attribution: 'Hi' });
  });
});
