/**
 * In-process QC remarks.
 *
 * A parameter marked Not OK must carry a remark, saved in English. Shop-floor
 * staff type or speak it in whatever language they use (Hindi, Bengali,
 * Gujarati, Hinglish, Banglish); OpenAI transcribes speech, because Claude
 * does not take audio, and Claude turns the text into English.
 */

import OpenAI, { toFile } from 'openai';
import { askText, MODELS } from './claude.js';

/** ProductionEntryProcessInspectionDetail.Remarks is NVARCHAR(1000). */
export const QC_REMARKS_MAX = 1000;

// Templates spell the negative many ways ("NOT OK", "Not Ok", "NOTOK", "NOK", "Fail").
const NOT_OK_RESULTS = new Set(['NOTOK', 'NOK', 'NOT', 'FAIL']);

export function isQcNotOk(result) {
  return NOT_OK_RESULTS.has(String(result ?? '').toUpperCase().replace(/[^A-Z]/g, ''));
}

/** Remark text in any of the plant's languages → plain English. */
export async function qcRemarkToEnglish(text) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  const { text: english } = await askText({
    feature: 'qc-remark-english',
    model: MODELS.fast,
    maxTokens: 1000,
    system: `You translate quality-control remarks written or spoken by shop-floor staff at a printing and packaging plant.
The input may be English, Hindi, Bengali, Gujarati, or a mix written in Latin letters (Hinglish, Banglish).
Reply with the remark in clear, simple English and nothing else: no quotes, no preface, no notes.
If it is already English, fix only obvious transcription errors and return it.
Keep trade terms, numbers, units, colour names and job/machine references exactly as given.`,
    content: source,
  });
  return english.trim().slice(0, QC_REMARKS_MAX);
}

let openai = null;

function extensionFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

/**
 * A recorded remark → { spoken, english }. `spoken` is empty when nothing
 * could be heard, and then `english` is too.
 */
export async function transcribeQcRemark(audio, mimeType) {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on the server.');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  const transcription = await openai.audio.transcriptions.create({
    file: await toFile(audio, `qc-remark.${extensionFor(mimeType)}`),
    model: 'gpt-4o-mini-transcribe',
  });
  const spoken = (transcription.text || '').trim();
  return { spoken, english: spoken ? await qcRemarkToEnglish(spoken) : '' };
}
