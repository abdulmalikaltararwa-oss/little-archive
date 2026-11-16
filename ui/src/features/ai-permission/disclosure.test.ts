import { describe, expect, it } from 'vitest';
import type { Features, Settings } from '@/data/types';
import { describeSharing, type EnrichmentStatus, type SharingContext } from './disclosure';

const features = (mode: Features['mode'], ai: boolean): Features => ({
  mode, unlocked: true,
  recipes: { available: true, locked: false, ai }, places: { available: true, locked: false, ai }, ask: { available: true, locked: false, ai, answers: ai },
  guided_import: { available: true, locked: false },
});

const OLLAMA: Partial<Settings> = { ai_enabled: true, ai_provider: 'ollama', ai_model: 'gemma', ai_hosted: false, transcription_available: false };
const GEMINI: Partial<Settings> = { ai_enabled: true, ai_provider: 'gemini', ai_model: 'gemini-flash', ai_hosted: true, transcription_available: false };
const NOTHING: Partial<Settings> = { ai_enabled: false, ai_provider: '', ai_model: '', ai_hosted: false, transcription_available: false };

const own = (settings: Partial<Settings>, status: EnrichmentStatus | null = null): SharingContext => ({ settings, features: features('self-hosted', Boolean(settings.ai_enabled)), hostedAccount: false, status });
const account = (settings: Partial<Settings>, status: EnrichmentStatus | null = null): SharingContext => ({ settings, features: features('hosted', Boolean(settings.ai_enabled)), hostedAccount: true, status });

const TEXT = 'title, caption, creator name, image descriptions and any transcript';
const GROQ_GEMINI: EnrichmentStatus = { analysis: { provider: 'gemini', hosted: true, evidence_mode: 'public' }, transcription: { provider: 'groq', auto: false } };

describe('what an AI action sends, and to whom', () => {
  it('asks nothing on a self-hosted server with a local model: nothing leaves it', () => {
    for (const action of ['suggest', 'recipe', 'places', 'ask', 'settings'] as const) expect(describeSharing(action, own(OLLAMA))).toBeNull();
  });

  it('asks nothing where no model is set up, because no action can send anything', () => {
    for (const action of ['suggest', 'recipe', 'places', 'ask', 'settings'] as const) expect(describeSharing(action, own(NOTHING))).toBeNull();
    // Recipes and places still work from the page's data and the fixed rules.
    expect(describeSharing('recipe', account(NOTHING))).toBeNull();
  });

  it('one yes covers every action, so every action and every service is named whichever one asked', () => {
    const settings = { ...GEMINI, transcription_available: true };
    const words = describeSharing('ask', account(settings, GROQ_GEMINI));
    expect(words?.title).toBe('Allow sending saves to an AI service?');
    expect(words?.lines).toEqual([
      { key: 'ask', name: 'Ask your archive', text: 'The question you type, and short passages from the saves that match it. The rest of your library is not sent.', current: true },
      { key: 'suggest', name: 'Suggestions', text: `For each save you choose: its ${TEXT}.`, current: false },
      { key: 'cards', name: 'Recipe cards and places', text: `The save’s ${TEXT}. Its link is not sent.`, current: false },
      { key: 'closer-read', name: 'A closer read', text: 'The post’s media file (sound and picture), to be written out as a transcript. Then the save’s title, caption, creator name, image descriptions and that transcript, so it can be read again.', current: false },
    ]);
    expect(words?.recipients).toBe('This service sends text to Google’s Gemini service and media files to Groq’s transcription service. What a service receives is handled under that service’s own terms, and cannot be taken back once it is sent.');
    expect(words?.notes).toBe('Your own notes and the names of your collections are not sent.');
    expect(words?.remembered).toBe('One answer covers all of these, and is kept with this account. You can change it in Settings.');
    // The same words whichever action asked; only the first line differs.
    for (const action of ['suggest', 'recipe', 'places', 'closer-read', 'settings'] as const) {
      const other = describeSharing(action, account(settings, GROQ_GEMINI));
      expect(other?.recipients).toBe(words?.recipients);
      expect(other?.lines.map(line => line.key).sort()).toEqual(['ask', 'cards', 'closer-read', 'suggest']);
    }
    expect(describeSharing('closer-read', account(settings, GROQ_GEMINI))?.lines[0]).toMatchObject({ key: 'closer-read', current: true });
    expect(describeSharing('places', account(settings, GROQ_GEMINI))?.lines[0]).toMatchObject({ key: 'cards', current: true });
    expect(describeSharing('settings', account(settings, GROQ_GEMINI))?.lines.some(line => line.current)).toBe(false);
  });

  it('says "media file (sound and picture)" for every transcriber, never just "audio"', () => {
    for (const provider of ['groq', 'gemini', 'something-new', null]) {
      const words = describeSharing('closer-read', own({ ...OLLAMA, transcription_available: true }, { transcription: { provider, auto: false } }));
      expect(JSON.stringify(words)).not.toMatch(/audio/i);
      expect(words?.lines[0]?.text).toBe('The post’s media file (sound and picture), to be written out as a transcript.');
    }
  });

  it('says "a hosted AI service" when the server names none it knows, and never calls a hosted account’s server "yours"', () => {
    const words = describeSharing('recipe', account({ ...GEMINI, ai_provider: 'something-new' }));
    expect(words?.lines[0]).toEqual({ key: 'cards', name: 'Recipe cards and places', text: `The save’s ${TEXT}. Its link is not sent.`, current: true });
    expect(words?.recipients).toMatch(/^This service sends the text to a hosted AI service\./);
    expect(words?.notes).toBe('Your own notes and the names of your collections are held back unless whoever runs this service has chosen to send them.');
    expect(JSON.stringify(words)).not.toMatch(/your server|private/i);
  });

  it('says so when the operator sends notes and collection names too', () => {
    expect(describeSharing('places', own(GEMINI, { analysis: { evidence_mode: 'full' } }))?.notes).toBe('Your own notes and the names of your collections are sent with the text.');
  });

  it('a server that only ranks saves sends nothing for a question, and the question is not listed', () => {
    const context = { ...account(GEMINI), features: features('hosted', false) };
    expect(describeSharing('ask', context)).toBeNull();
    expect(describeSharing('suggest', context)?.lines.map(line => line.key)).toEqual(['suggest']);
  });

  it('asks before a closer read even beside a local model: the media file goes to the transcription service', () => {
    const settings = { ...OLLAMA, transcription_available: true };
    const words = describeSharing('closer-read', own(settings, { analysis: { provider: 'ollama', hosted: false, evidence_mode: 'full' }, transcription: { provider: 'groq', auto: false } }));
    expect(words?.lines).toEqual([{ key: 'closer-read', name: 'A closer read', text: 'The post’s media file (sound and picture), to be written out as a transcript.', current: true }]);
    expect(words?.recipients).toMatch(/^Your server sends the media file to Groq’s transcription service\./);
    expect(words?.notes).toBe('');
    expect(words?.remembered).toBe('One answer covers all of these, and is kept with this library. You can change it in Settings.');
    // With no automatic transcription, a suggestion on that server stays on it.
    expect(describeSharing('suggest', own(settings, { transcription: { provider: 'groq', auto: false } }))).toBeNull();
  });

  it('names one service once when it receives both the text and the media file', () => {
    const settings = { ...GEMINI, transcription_available: true };
    const words = describeSharing('closer-read', account(settings, { analysis: { provider: 'gemini', hosted: true }, transcription: { provider: 'gemini', auto: false } }));
    expect(words?.recipients).toMatch(/^This service sends text and media files to Google’s Gemini service\./);
  });

  it('mentions the media file for suggestions when the server transcribes thin captions by itself, and says "may" when it could not be asked', () => {
    const settings = { ...OLLAMA, transcription_available: true };
    const known = describeSharing('suggest', own(settings, { transcription: { provider: 'groq', auto: true } }));
    expect(known?.lines[0]?.text).toBe('When a video’s caption says too little, the post’s media file (sound and picture) is sent first, to be written out as a transcript.');
    const unknown = describeSharing('suggest', own(settings, null));
    expect(unknown?.lines[0]?.text).toBe('When a video’s caption says too little, the post’s media file (sound and picture) may be sent first, to be written out as a transcript.');
    expect(unknown?.recipients).toMatch(/^Your server sends the media file to a hosted transcription service\./);
  });

  it('still asks a hosted account whose service runs its own model, and says whose model it is', () => {
    const words = describeSharing('suggest', account(OLLAMA, { analysis: { provider: 'ollama', hosted: false, evidence_mode: 'full' } }));
    expect(words?.recipients).toBe('This service sends the text to an AI model run by whoever runs this service. It cannot be taken back once it is sent.');
    expect(words?.notes).toBe('Your own notes and the names of your collections are sent with the text.');
  });
});
