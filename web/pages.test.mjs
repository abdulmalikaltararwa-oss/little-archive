// The plain pages of the public site (privacy, terms, support, account deletion): every link lands somewhere,
// nothing is loaded from another site, no script runs, and the contact address is written once per page.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = ['privacy.html', 'terms.html', 'support.html', 'delete-account.html'];
const read = name => readFileSync(join(here, name), 'utf8');
const attributes = (html, tag, name) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, 'g'))].map(match => match[1]);
const ids = html => new Set(attributes(html, '[a-z0-9]+', 'id'));
const external = value => /^https:\/\//.test(value);

for (const name of PAGES) {
  const html = read(name);

  test(`${name} is a complete, plain document`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en" dir="ltr">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    assert.match(html, /<title>[^<]+ — Little Archive<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]{40,160}">/);
    assert.equal(html.match(/<h1\b/g)?.length, 1, 'one h1');
    assert.equal(html.match(/<main\b/g)?.length, 1, 'one main');
    assert.match(html, /<a class="skip" href="#main">/);
    // Headings never skip a level.
    let last = 1;
    for (const [, level] of html.matchAll(/<h([1-6])\b/g)) {
      assert.ok(Number(level) <= last + 1, `h${level} follows h${last}`);
      last = Number(level);
    }
    for (const image of html.match(/<img\b[^>]*>/g) ?? []) assert.match(image, /\salt="/, 'every image has alt text');
    for (const cell of html.match(/<th\b[^>]*>/g) ?? []) assert.match(cell, /\sscope="(col|row)"/, 'every header cell has a scope');
  });

  test(`${name} runs no script and loads nothing from another site`, () => {
    assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|\son[a-z]+="|\sstyle="|<style\b/i);
    assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"/);
    for (const source of [...attributes(html, 'img', 'src'), ...attributes(html, 'link', 'href')]) {
      assert.match(source, /^\.\/[a-z0-9./-]+$/, `${source} is a file beside the page`);
      assert.ok(existsSync(join(here, source)), `${source} exists`);
    }
  });

  test(`${name} links only to places that exist`, () => {
    const links = attributes(html, 'a', 'href');
    assert.ok(links.length > 8);
    for (const link of links) {
      if (external(link)) continue;
      assert.doesNotMatch(link, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${link} is relative, so the pages work under any site path`);
      const [path, anchor] = link.split('#');
      if (path === './') continue; // the site's front page
      const target = path ? path.replace(/^\.\//, '') : name;
      assert.ok(PAGES.includes(target), `${link} names one of the pages`);
      if (anchor) assert.ok(ids(read(target)).has(anchor), `${link} has its anchor`);
    }
    const footer = html.slice(html.indexOf('<footer'));
    for (const other of PAGES) assert.ok(footer.includes(`href="./${other}"`), `the footer links to ${other}`);
  });

  test(`${name} writes the contact address once, as text`, () => {
    assert.equal(html.split('support@').length - 1, 1);
    assert.doesNotMatch(html, /mailto:/);
    assert.ok(ids(html).has('contact'));
  });
}

test('the stylesheet uses only its own font file and both themes', () => {
  const css = read('pages.css');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(match => match[1].replace(/['"]/g, ''));
  assert.deepEqual(urls, ['./fonts/fraunces-soft.woff2']);
  assert.ok(existsSync(join(here, urls[0])));
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(css, /@import/);
});

test('the pages say only what the service does', () => {
  for (const name of PAGES) {
    const text = read(name).replace(/<[^>]+>/g, ' ');
    // The operator can read a hosted library, so these words would promise too much.
    assert.doesNotMatch(text, /\b(?:end-to-end encrypted library|fully private|completely secure|military-grade|we cannot read)\b/i, name);
    assert.doesNotMatch(text, /\bsubscri(?:be|ption) (?:fee|plan)\b/i, name);
  }
  assert.match(read('privacy.html'), /able to read it/);
  assert.match(read('delete-account.html'), /30 days/);
});
