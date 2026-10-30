'use strict';

// Her ears without a key: Whisper running on this machine (transformers.js), the model downloaded
// once into her folder. Slower than the API and not as good on Uzbek, but free and private.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const MODEL = 'onnx-community/whisper-small';
const MAX_AUDIO = 20 * 1024 * 1024;
const IDLE_UNLOAD = 10 * 60 * 1000; // the model takes a few hundred MB: she lets it go once idle
const LANGS = { fr: 'french', en: 'english', es: 'spanish', pt: 'portuguese', ru: 'russian', uz: 'uzbek' };

let transcriber = null; // a promise: the model loads once, then answers from memory
let busy = Promise.resolve(); // one recording at a time
let unloadTimer = null;

function ffmpeg() {
  let bin = '';
  try {
    bin = require('ffmpeg-static');
  } catch {
    return '';
  }
  // packaged, the binary sits beside the archive, not inside it
  return bin.includes('app.asar') ? bin.replace('app.asar', 'app.asar.unpacked') : bin;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 60000, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? `: ${String(stderr).trim().split('\n').pop()}` : ''}`));
      else resolve();
    });
  });
}

// 16-bit mono PCM out of the WAV ffmpeg wrote, as the float samples the model wants.
function samples(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const end = Math.min(offset + 8 + size, buffer.length);
      const count = Math.floor((end - offset - 8) / 2);
      const audio = new Float32Array(count);
      for (let i = 0; i < count; i++) audio[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768;
      return audio;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no audio in the recording');
}

async function load() {
  clearTimeout(unloadTimer);
  if (!transcriber) {
    transcriber = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(app.getPath('userData'), 'models');
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' });
    })();
    transcriber.catch(() => {
      transcriber = null; // a failed download is tried again next time
    });
  }
  return transcriber;
}

function idle() {
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    const model = transcriber;
    transcriber = null;
    model?.then((asr) => asr.dispose?.()).catch(() => {});
  }, IDLE_UNLOAD);
  unloadTimer.unref?.();
}

// Your voice, as text. request: { audio: base64, mime, lang }
async function transcribe(request = {}) {
  const { audio, mime = 'audio/webm', lang = 'en' } = request;
  if (typeof audio !== 'string' || !audio) return { ok: false, error: 'no audio' };
  const buffer = Buffer.from(audio, 'base64');
  if (!buffer.length) return { ok: false, error: 'no audio' };
  if (buffer.length > MAX_AUDIO) return { ok: false, code: 'toolong', error: 'audio too long' };
  const bin = ffmpeg();
  if (!bin) return { ok: false, code: 'local', error: 'ffmpeg is missing' };
  const type = String(mime).split(';')[0];
  const ext = /ogg/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /wav/.test(type) ? 'wav' : 'webm';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capri-ears-'));
  try {
    const input = path.join(dir, `speech.${ext}`);
    const wav = path.join(dir, 'speech.wav');
    await fs.writeFile(input, buffer);
    await run(bin, ['-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', wav]);
    const pcm = samples(await fs.readFile(wav));
    let text = '';
    busy = busy.catch(() => {}).then(async () => {
      const asr = await load();
      const out = await asr(pcm, { language: LANGS[lang] || 'english', task: 'transcribe' });
      text = String(out?.text || '').trim();
    });
    await busy;
    idle();
    if (text) console.log(`[capri] heard (${LANGS[lang] || 'english'}): "${text}"`);
    return { ok: true, text, provider: 'local' };
  } catch (err) {
    return { ok: false, code: 'local', error: err.message };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { transcribe, MODEL };
