// What an AI action would send, and to whom, worked out from what the server itself reports (GET /api/settings,
// GET /api/features, GET /api/enrichment/status). Nothing here guesses: when the server does not name a service
// the words say "a hosted AI service", and when nothing would leave the person's own server there is nothing to
// ask and `describeSharing` returns null.
import type { Features, Settings } from '@/data/types';

/** The actions that can send saved content to a model. 'settings' is the switch in Settings, which covers them all. */
export type AiAction = 'suggest' | 'closer-read' | 'recipe' | 'places' | 'ask' | 'settings';

/** GET /api/enrichment/status, as far as this module reads it. */
export interface EnrichmentStatus {
  analysis?: { provider?: string | null; hosted?: boolean; evidence_mode?: string | null };
  transcription?: { provider?: string | null; auto?: boolean };
}

export interface SharingContext {
  settings: Partial<Settings>;
  features: Features | null;
  /** True for an account on a hosted service, where the server is someone else's. */
  hostedAccount: boolean;
  /** Null when it has not been read, or could not be: the words then stay general and nothing is assumed safe. */
  status: EnrichmentStatus | null;
}

export interface Disclosure {
  action: AiAction;
  title: string;
  /** What is sent, one sentence each. */
  sent: string[];
  /** Who receives it. */
  recipients: string;
  /** What happens to the person's own notes and collection names. Empty when no text is sent. */
  notes: string;
  /** Where the answer is kept. */
  remembered: string;
}

const TEXT_SERVICES: Record<string, string> = { gemini: 'Google’s Gemini service' };
const AUDIO_SERVICES: Record<string, string> = { gemini: 'Google’s Gemini service', groq: 'Groq’s transcription service' };

const SAVE_TEXT = 'title, caption, creator name, image descriptions and any transcript';

function featureUsesAi(features: Features | null, name: 'recipes' | 'places', settings: Partial<Settings>): boolean {
  const flag = features?.[name];
  return typeof flag?.ai === 'boolean' ? flag.ai : Boolean(settings.ai_enabled);
}

function askWritesAnswers(features: Features | null, settings: Partial<Settings>): boolean {
  const flag = features?.ask;
  if (typeof flag?.answers === 'boolean') return flag.answers;
  if (typeof flag?.ai === 'boolean') return flag.ai;
  return Boolean(settings.ai_enabled);
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The words for the permission step, or null when this action sends nothing beyond the person's own server
 * (a self-hosted server with a local model, or no model at all).
 */
export function describeSharing(action: AiAction, { settings, features, hostedAccount, status }: SharingContext): Disclosure | null {
  const modelSet = Boolean(settings.ai_enabled);
  const thirdPartyModel = modelSet && Boolean(settings.ai_hosted || status?.analysis?.hosted);
  // A hosted account's text goes to a model on someone else's machine even when that model is not a third-party service.
  const operatorModel = modelSet && !thirdPartyModel && hostedAccount;
  const textLeaves = thirdPartyModel || operatorModel;
  const canTranscribe = Boolean(settings.transcription_available);
  // Without the status the server's rule for thin captions is unknown, so it is taken to be on.
  const transcribesAlone = canTranscribe && (status ? Boolean(status.transcription?.auto) : true);

  const textFor = {
    suggest: textLeaves,
    'closer-read': textLeaves,
    recipe: featureUsesAi(features, 'recipes', settings) && textLeaves,
    places: featureUsesAi(features, 'places', settings) && textLeaves,
    ask: askWritesAnswers(features, settings) && textLeaves,
    settings: textLeaves,
  }[action];
  // A closer read is always a transcription, and a transcription is always made by a service outside the server.
  const audioFor = { suggest: modelSet && transcribesAlone, 'closer-read': true, recipe: false, places: false, ask: false, settings: canTranscribe }[action];
  if (!textFor && !audioFor) return null;

  const audioName = status?.transcription?.provider ?? '';
  // Gemini is given the post's whole media file; a speech service is given the sound.
  const media = audioName === 'gemini' ? 'the post’s media file (sound and picture)' : 'the post’s audio';
  const sent: string[] = [];
  if (action === 'suggest') {
    if (textFor) sent.push(`For each save you choose: its ${SAVE_TEXT}.`);
    if (audioFor) sent.push(`When a video’s caption says too little, ${media} is sent first, to be written out as a transcript.`);
  } else if (action === 'closer-read') {
    sent.push(`${capital(media)}, to be written out as a transcript.`);
    if (textFor) sent.push(`Then the save’s ${SAVE_TEXT.replace('any transcript', 'that transcript')}, so it can be read again.`);
  } else if (action === 'ask') {
    sent.push('The question you type, and short passages from the saves that match it. The rest of your library is not sent.');
  } else if (action === 'settings') {
    if (textFor) sent.push(`For suggestions, recipe cards and places: a save’s ${SAVE_TEXT}.`);
    if (audioFor) sent.push(`For a closer read: ${media}.`);
    if (textFor && askWritesAnswers(features, settings)) sent.push('For a question you ask: the question, and short passages from the saves that match it.');
  } else {
    sent.push(`This save’s ${SAVE_TEXT}. Its link is not sent.`);
  }

  const sender = hostedAccount ? 'This service' : 'Your server';
  const textTo = thirdPartyModel
    ? TEXT_SERVICES[settings.ai_provider ?? ''] ?? TEXT_SERVICES[status?.analysis?.provider ?? ''] ?? 'a hosted AI service'
    : 'an AI model run by whoever runs this service';
  const audioTo = AUDIO_SERVICES[audioName] ?? 'a hosted transcription service';
  const outside = (textFor && thirdPartyModel) || audioFor;
  const where = textFor && audioFor
    ? textTo === audioTo ? `${sender} sends both to ${textTo}.` : `${sender} sends the ${audioName === 'gemini' ? 'media file' : 'audio'} to ${audioTo} and the text to ${textTo}.`
    : `${sender} sends it to ${textFor ? textTo : audioTo}.`;
  const after = outside ? 'What a service receives is handled under that service’s own terms, and cannot be taken back once it is sent.' : 'It cannot be taken back once it is sent.';

  const mode = status?.analysis?.evidence_mode;
  const notes = !textFor
    ? ''
    : mode === 'public'
      ? 'Your own notes and the names of your collections are not sent.'
      : mode === 'full'
        ? 'Your own notes and the names of your collections are sent with it.'
        : `Your own notes and the names of your collections are held back unless whoever runs ${hostedAccount ? 'this service' : 'your server'} has chosen to send them.`;

  return {
    action,
    title: action === 'settings' ? 'Allow sending saves to an AI service?' : 'Send this to an AI service?',
    sent,
    recipients: `${where} ${after}`,
    notes,
    remembered: `Your answer is kept with this ${hostedAccount ? 'account' : 'library'}. You can change it in Settings.`,
  };
}
