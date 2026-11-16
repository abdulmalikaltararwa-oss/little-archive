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

describe('what an AI action sends, and to whom', () => {
  it('asks nothing on a self-hosted server with a local model: nothing leaves it', () => {
    for (const action of ['suggest', 'recipe', 'places', 'ask', 'settings'] as const) expect(describeSharing(action, own(OLLAMA))).toBeNull();
  });

  it('asks nothing where no model is set up, because no action can send anything', () => {
    for (const action of ['suggest', 'recipe', 'places', 'ask', 'settings'] as const) expect(describeSharing(action, own(NOTHING))).toBeNull();
    // Recipes and places still work from the page's data and the fixed rules.
    expect(describeSharing('recipe', account(NOTHING))).toBeNull();
  });

  it('names Google when the server reports Gemini, and lists what a suggestion is made from', () => {
    const words = describeSharing('suggest', own(GEMINI, { analysis: { provider: 'gemini', hosted: true, evidence_mode: 'public' }, transcription: { provider: null, auto: false } }));
    expect(words?.title).toBe('Send this to an AI service?');
    expect(words?.sent).toEqual(['For each save you choose: its title, caption, creator name, image descriptions and any transcript.']);
    expect(words?.recipients).toBe('Your server sends it to Google’s Gemini service. What a service receives is handled under that service’s own terms, and cannot be taken back once it is sent.');
    expect(words?.notes).toBe('Your own notes and the names of your collections are not sent.');
    expect(words?.remembered).toBe('Your answer is kept with this library. You can change it in Settings.');
  });

  it('says "a hosted AI service" when the server names none it knows, and never calls a hosted account’s server "yours"', () => {
    const words = describeSharing('recipe', account({ ...GEMINI, ai_provider: 'something-new' }));
    expect(words?.sent).toEqual(['This save’s title, caption, creator name, image descriptions and any transcript. Its link is not sent.']);
    expect(words?.recipients).toMatch(/^This service sends it to a hosted AI service\./);
    expect(words?.notes).toBe('Your own notes and the names of your collections are held back unless whoever runs this service has chosen to send them.');
    expect(words?.remembered).toBe('Your answer is kept with this account. You can change it in Settings.');
    expect(JSON.stringify(words)).not.toMatch(/your server|private/i);
  });

  it('says so when the operator sends notes and collection names too', () => {
    expect(describeSharing('places', own(GEMINI, { analysis: { evidence_mode: 'full' } }))?.notes).toBe('Your own notes and the names of your collections are sent with it.');
  });

  it('describes a question: the words typed and passages from matching saves', () => {
    const words = describeSharing('ask', account(GEMINI));
    expect(words?.sent).toEqual(['The question you type, and short passages from the saves that match it. The rest of your library is not sent.']);
    // A server that only ranks saves sends nothing for a question.
    expect(describeSharing('ask', { ...account(GEMINI), features: features('hosted', false) })).toBeNull();
  });

  it('asks before a closer read even beside a local model: the audio goes to the transcription service', () => {
    const settings = { ...OLLAMA, transcription_available: true };
    const words = describeSharing('closer-read', own(settings, { analysis: { provider: 'ollama', hosted: false, evidence_mode: 'full' }, transcription: { provider: 'groq', auto: false } }));
    expect(words?.sent).toEqual(['The post’s audio, to be written out as a transcript.']);
    expect(words?.recipients).toMatch(/^Your server sends it to Groq’s transcription service\./);
    expect(words?.notes).toBe('');
    // With no automatic transcription, a suggestion on that server stays on it.
    expect(describeSharing('suggest', own(settings, { transcription: { provider: 'groq', auto: false } }))).toBeNull();
  });

  it('a closer read with Gemini sends the whole media file, and then the text', () => {
    const settings = { ...GEMINI, transcription_available: true };
    const words = describeSharing('closer-read', account(settings, { analysis: { provider: 'gemini', hosted: true, evidence_mode: 'public' }, transcription: { provider: 'gemini', auto: false } }));
    expect(words?.sent).toEqual([
      'The post’s media file (sound and picture), to be written out as a transcript.',
      'Then the save’s title, caption, creator name, image descriptions and that transcript, so it can be read again.',
    ]);
    expect(words?.recipients).toMatch(/^This service sends both to Google’s Gemini service\./);
  });

  it('names both services when the audio and the text go to different ones', () => {
    const settings = { ...GEMINI, transcription_available: true };
    const words = describeSharing('closer-read', own(settings, { transcription: { provider: 'groq', auto: false } }));
    expect(words?.recipients).toMatch(/^Your server sends the audio to Groq’s transcription service and the text to Google’s Gemini service\./);
  });

  it('mentions the audio for suggestions when the server transcribes thin captions by itself, and assumes it does when it could not be asked', () => {
    const settings = { ...OLLAMA, transcription_available: true };
    const known = describeSharing('suggest', own(settings, { transcription: { provider: 'groq', auto: true } }));
    expect(known?.sent).toEqual(['When a video’s caption says too little, the post’s audio is sent first, to be written out as a transcript.']);
    const unknown = describeSharing('suggest', own(settings, null));
    expect(unknown?.recipients).toMatch(/^Your server sends it to a hosted transcription service\./);
  });

  it('still asks a hosted account whose service runs its own model, and says whose model it is', () => {
    const words = describeSharing('suggest', account(OLLAMA, { analysis: { provider: 'ollama', hosted: false, evidence_mode: 'full' } }));
    expect(words?.recipients).toBe('This service sends it to an AI model run by whoever runs this service. It cannot be taken back once it is sent.');
    expect(words?.notes).toBe('Your own notes and the names of your collections are sent with it.');
  });

  it('the Settings switch covers everything the server could send', () => {
    const words = describeSharing('settings', account({ ...GEMINI, transcription_available: true }, { transcription: { provider: 'groq' } }));
    expect(words?.title).toBe('Allow sending saves to an AI service?');
    expect(words?.sent).toEqual([
      'For suggestions, recipe cards and places: a save’s title, caption, creator name, image descriptions and any transcript.',
      'For a closer read: the post’s audio.',
      'For a question you ask: the question, and short passages from the saves that match it.',
    ]);
  });
});
