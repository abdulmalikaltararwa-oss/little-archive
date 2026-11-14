import { afterEach, describe, expect, it } from 'vitest';
import { clearSession, EMPTY_SESSION, formatScale, parseScale, parseSession, readScale, readSession, readSound, writeScale, writeSession, writeSound } from './memory';
import { newTimer, startTimer } from './timers';

afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('the scale carried from a card to cook mode', () => {
  it('round-trips both kinds', () => {
    expect(parseScale(formatScale({ kind: 'servings', value: 6 }))).toEqual({ kind: 'servings', value: 6 });
    expect(parseScale(formatScale({ kind: 'factor', value: 0.5 }))).toEqual({ kind: 'factor', value: 0.5 });
  });

  it('refuses anything else', () => {
    for (const bad of [null, '', 's:', 's:0', 'x:2', 's:-1', 's:2;drop', 's:1e9', 'servings:4']) expect(parseScale(bad)).toBeNull();
  });

  it('is remembered for one recipe only', () => {
    writeScale('a', { kind: 'servings', value: 6 });
    expect(readScale('a')).toEqual({ kind: 'servings', value: 6 });
    expect(readScale('b')).toBeNull();
  });
});

describe('a cook session', () => {
  const stamp = 'edited:2026-11-14|rules:2026-11-14';

  it('survives a reload with its timers', () => {
    const timer = startTimer(newTimer(600), 1_000);
    writeSession('a', { stamp, step: 2, checked: [0, 3], timers: { 1: timer } });
    expect(readSession('a', stamp)).toEqual({ stamp, step: 2, checked: [0, 3], timers: { 1: timer } });
  });

  it('is forgotten when the recipe has changed since', () => {
    writeSession('a', { ...EMPTY_SESSION(stamp), step: 3 });
    expect(readSession('a', 'another version')).toBeNull();
  });

  it('can be cleared', () => {
    writeSession('a', EMPTY_SESSION(stamp));
    clearSession('a');
    expect(readSession('a', stamp)).toBeNull();
  });

  it('drops what is wrong in it rather than trusting it', () => {
    expect(parseSession('not json', stamp)).toBeNull();
    expect(parseSession('[]', stamp)).toBeNull();
    expect(parseSession(JSON.stringify({ stamp, step: -1 }), stamp)).toBeNull();
    const mixed = parseSession(JSON.stringify({ stamp, step: 1, checked: [0, 'x', -2, 5.5, 4], timers: { 0: { status: 'idle', total: 60_000 }, 1: { status: 'bad' }, x: { status: 'idle', total: 60_000 } } }), stamp);
    expect(mixed).toEqual({ stamp, step: 1, checked: [0, 4], timers: { 0: { status: 'idle', total: 60_000 } } });
  });
});

describe('the alarm sound', () => {
  it('is on until it is turned off', () => {
    expect(readSound()).toBe(true);
    writeSound(false);
    expect(readSound()).toBe(false);
    writeSound(true);
    expect(readSound()).toBe(true);
  });
});
