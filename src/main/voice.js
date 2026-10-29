'use strict';

// Her voice. Your microphone, through Whisper at OpenAI or Groq (a key she already has), and her
// answers read out loud: OpenAI's voice with that same key (Uzbek included), Google's free one for
// the languages it has a voice for, and the Windows voices the renderer falls back to. Keys never
// leave the main process.

const OPENAI_STT = 'https://api.openai.com/v1/audio/transcriptions';
const GROQ_STT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_TTS = 'https://api.openai.com/v1/audio/speech';
const MAX_AUDIO = 20 * 1024 * 1024; // a recording longer than this is a mistake
const MAX_SPEECH = 900; // her answers are short; anything longer is cut, not read for minutes
const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_VOICE = 'nova'; // warm, and at ease in every language she speaks
// said in English, as the model wants: the words still come out in the language they're written in
const TTS_STYLE = 'You are Capri, a warm, playful, slightly sassy desktop companion. Natural pace, light and lively, never robotic.';
// Google's free read-aloud has no Uzbek voice (and no key of its own): those answers are OpenAI's
const GOOGLE_LANG = { fr: 'fr', en: 'en', es: 'es', pt: 'pt', ru: 'ru' };

// Which key she has for listening: OpenAI first (the better transcriber), else Groq.
function keys(cfg = {}) {
  const apiKeys = cfg.apiKeys || {};
  return {
    openai: apiKeys.openai || process.env.OPENAI_API_KEY || '',
    groq: apiKeys.groq || process.env.GROQ_API_KEY || '',
  };
}

function status(cfg = {}) {
  const { openai, groq } = keys(cfg);
  const provider = openai ? 'openai' : groq ? 'groq' : null;
  return provider ? { ok: true, provider } : { ok: false, code: 'nokey', provider: null };
}

// A key pasted for her ears and voice: checked now, so a typo is said right away (the models list
// is the cheapest call either service has).
async function checkKey(provider, key) {
  const url = provider === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://api.openai.com/v1/models';
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    const short = (body.match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || `${res.status} ${res.statusText}`;
    return { ok: false, error: short };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Your voice, as text. request: { audio: base64, mime, lang }
async function transcribe(request, cfg = {}) {
  const { audio, mime = 'audio/webm', lang = 'fr' } = request;
  if (typeof audio !== 'string' || !audio) return { ok: false, error: 'no audio' };
  const buffer = Buffer.from(audio, 'base64');
  if (!buffer.length) return { ok: false, error: 'no audio' };
  if (buffer.length > MAX_AUDIO) return { ok: false, code: 'toolong', error: 'audio too long' };
  const { openai, groq } = keys(cfg);
  const provider = openai ? 'openai' : groq ? 'groq' : null;
  const key = openai || groq;
  if (!key) return { ok: false, code: 'nokey', error: 'no API key for speech' };
  const type = String(mime).split(';')[0];
  const ext = /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `speech.${ext}`);
  form.append('model', provider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-large-v3-turbo');
  if (lang) form.append('language', String(lang).slice(0, 5));
  form.append('response_format', 'json');
  try {
    const res = await fetch(provider === 'openai' ? OPENAI_STT : GROQ_STT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const short = (body.match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || `${res.status} ${res.statusText}`;
      return { ok: false, error: short };
    }
    const data = await res.json();
    return { ok: true, text: String(data.text || '').trim(), provider };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Her answer out loud: { audio: base64 mp3, mime, voice }. OpenAI first, Google for the languages
// it has; when neither can, the renderer speaks it with the Windows voices.
async function speak(request = {}, cfg = {}) {
  const { lang = 'fr' } = request;
  const text = tidy(request.text);
  if (!text) return { ok: false, error: 'nothing to say' };
  const { openai } = keys(cfg);
  let error = '';
  if (openai) {
    try {
      return { ok: true, audio: await openaiVoice(text, openai), mime: 'audio/mpeg', voice: 'openai' };
    } catch (err) {
      error = err.message;
    }
  }
  if (GOOGLE_LANG[lang]) {
    try {
      return { ok: true, audio: await google(text, lang), mime: 'audio/mpeg', voice: 'google' };
    } catch (err) {
      error = error || err.message;
    }
  }
  return { ok: false, error: error || `no voice for ${lang}` };
}

// What she says, not what she writes it in: no marks, no emoji, no markup, and a sane length.
function tidy(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`#~|>]+/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH)
    .trim();
}

async function openaiVoice(text, key) {
  const res = await fetch(OPENAI_TTS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: 'mp3',
      instructions: TTS_STYLE,
      speed: 1.02,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const short = (body.match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || `${res.status} ${res.statusText}`;
    throw new Error(`openai voice ${short}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error('openai voice sent no audio');
  return audio.toString('base64');
}

// Google's free one: one short request per sentence (it takes about 200 characters at a time).
async function google(text, lang) {
  const tl = GOOGLE_LANG[lang] || 'en';
  const sentences = text.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const parts = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest) {
      let cut = Math.min(190, rest.length);
      if (cut < rest.length) {
        const space = rest.lastIndexOf(' ', cut);
        if (space > 40) cut = space;
      }
      const piece = rest.slice(0, cut).trim();
      rest = rest.slice(cut).trim();
      if (!piece) continue;
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + tl
        + `&total=1&idx=0&textlen=${piece.length}&q=${encodeURIComponent(piece)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`google voice ${res.status}`);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
  }
  if (!parts.length) throw new Error('google voice sent no audio');
  return Buffer.concat(parts).toString('base64');
}

module.exports = { status, checkKey, transcribe, speak };
