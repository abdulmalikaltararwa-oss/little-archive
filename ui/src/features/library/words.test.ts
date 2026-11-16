import { describe, expect, it } from 'vitest';
import { keptLine } from './words';

describe('the line under the library', () => {
  it('says "your server" only where the person runs the server', () => {
    expect(keptLine('browser', 'self-hosted')).toBe('Your collection. Your server. A little more peace of mind.');
    expect(keptLine('native', 'self-hosted')).toBe('Your collection. Your server. A little more peace of mind.');
  });
  it('does not claim a server or privacy on a hosted account', () => {
    const line = keptLine('native', 'hosted');
    expect(line).toBe('Your collection. Your account. A little more peace of mind.');
    expect(line).not.toMatch(/server|private/i);
  });
  it('does not claim a server for the demo, which has none', () => {
    expect(keptLine('demo', 'self-hosted')).not.toMatch(/server|account|private/i);
  });
});
