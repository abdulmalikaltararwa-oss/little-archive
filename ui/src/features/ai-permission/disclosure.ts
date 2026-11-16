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

/** One kind of action, and what it sends. */
export interface SharingLine {
  key: 'suggest' | 'cards' | 'ask' | 'closer-read';
  name: string;
  text: string;
  /** True for the action that brought the question up; it is listed first. */
  current: boolean;
}

/**
 * The whole of what one "Allow" covers: every kind of action this server could send something for, not only
 * the one that brought the question up, because the answer is kept for all of them.
 */
export interface Disclosure {
  action: AiAction;
  title: string;
  lines: SharingLine[];
  /** Who receives it: every service the server reports. */
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

const MEDIA = 'the post’s media file (sound and picture)';

/**
 * The words for the permission step, or null when this action sends nothing beyond the person's own server
 * (a self-hosted server with a local model, or no model at all). When there is something to ask, the words
 * cover every kind of action, with the one that was asked for first.
 */
export function describeSharing(action: AiAction, { settings, features, hostedAccount, status }: SharingContext): Disclosure | null {
  const modelSet = Boolean(settings.ai_enabled);
  const thirdPartyModel = modelSet && Boolean(settings.ai_hosted || status?.analysis?.hosted);
  // A hosted account's text goes to a model on someone else's machine even when that model is not a third-party service.
  const operatorModel = modelSet && !thirdPartyModel && hostedAccount;
  const textLeaves = thirdPartyModel || operatorModel;
  const canTranscribe = Boolean(settings.transcription_available);
  // Without the status the server's rule for thin captions is unknown, so it is taken to be on.
  const transcribesAlone = modelSet && canTranscribe && (status ? Boolean(status.transcription?.auto) : true);
  const cardsUseAi = (featureUsesAi(features, 'recipes', settings) || featureUsesAi(features, 'places', settings)) && textLeaves;
  const askUsesAi = askWritesAnswers(features, settings) && textLeaves;

  // Whether this one action would send anything. A closer read is always a transcription, and a transcription
  // is always made by a service outside the server, which is given the whole fetched media file.
  const asks = {
    suggest: textLeaves || transcribesAlone,
    'closer-read': true,
    recipe: featureUsesAi(features, 'recipes', settings) && textLeaves,
    places: featureUsesAi(features, 'places', settings) && textLeaves,
    ask: askUsesAi,
    settings: textLeaves || canTranscribe,
  }[action];
  if (!asks) return null;

  const mediaLeaves = canTranscribe || action === 'closer-read';
  const current = action === 'recipe' || action === 'places' ? 'cards' : action;
  const lines: SharingLine[] = [];
  if (textLeaves || transcribesAlone) {
    const thin = transcribesAlone ? ` When a video’s caption says too little, ${MEDIA} ${status ? 'is' : 'may be'} sent first, to be written out as a transcript.` : '';
    lines.push({ key: 'suggest', name: 'Suggestions', text: `${textLeaves ? `For each save you choose: its ${SAVE_TEXT}.` : ''}${thin}`.trim(), current: false });
  }
  if (cardsUseAi) lines.push({ key: 'cards', name: 'Recipe cards and places', text: `The save’s ${SAVE_TEXT}. Its link is not sent.`, current: false });
  if (askUsesAi) lines.push({ key: 'ask', name: 'Ask your archive', text: 'The question you type, and short passages from the saves that match it. The rest of your library is not sent.', current: false });
  if (mediaLeaves) {
    const then = textLeaves ? ` Then the save’s ${SAVE_TEXT.replace('any transcript', 'that transcript')}, so it can be read again.` : '';
    lines.push({ key: 'closer-read', name: 'A closer read', text: `${capital(MEDIA)}, to be written out as a transcript.${then}`, current: false });
  }
  for (const line of lines) line.current = line.key === current;
  lines.sort((first, second) => Number(second.current) - Number(first.current));

  const sender = hostedAccount ? 'This service' : 'Your server';
  const textTo = thirdPartyModel
    ? TEXT_SERVICES[settings.ai_provider ?? ''] ?? TEXT_SERVICES[status?.analysis?.provider ?? ''] ?? 'a hosted AI service'
    : 'an AI model run by whoever runs this service';
  const mediaTo = AUDIO_SERVICES[status?.transcription?.provider ?? ''] ?? 'a hosted transcription service';
  const where = textLeaves && mediaLeaves
    ? textTo === mediaTo ? `${sender} sends text and media files to ${textTo}.` : `${sender} sends text to ${textTo} and media files to ${mediaTo}.`
    : textLeaves ? `${sender} sends the text to ${textTo}.` : `${sender} sends the media file to ${mediaTo}.`;
  const after = thirdPartyModel || mediaLeaves ? 'What a service receives is handled under that service’s own terms, and cannot be taken back once it is sent.' : 'It cannot be taken back once it is sent.';

  const mode = status?.analysis?.evidence_mode;
  const notes = !textLeaves
    ? ''
    : mode === 'public'
      ? 'Your own notes and the names of your collections are not sent.'
      : mode === 'full'
        ? 'Your own notes and the names of your collections are sent with the text.'
        : `Your own notes and the names of your collections are held back unless whoever runs ${hostedAccount ? 'this service' : 'your server'} has chosen to send them.`;

  return {
    action,
    title: 'Allow sending saves to an AI service?',
    lines,
    recipients: `${where} ${after}`,
    notes,
    remembered: `One answer covers all of these, and is kept with this ${hostedAccount ? 'account' : 'library'}. You can change it in Settings.`,
  };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
