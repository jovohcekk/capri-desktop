// Her answers out loud: the main process makes the audio (voice.js: OpenAI's voice, then Google's
// free one), and this plays it. Windows' own voices are the last try, when nothing else comes back.

const SYSTEM_LANG = { uz: 'uz-UZ', fr: 'fr-FR', en: 'en-US', es: 'es-ES', pt: 'pt-BR', ru: 'ru-RU' };

function bytes(base64) {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class Speaker {
  constructor({ host, volume = 0.7 } = {}) {
    this.host = host;
    this.enabled = false; // her answers read out loud, unless she was only spoken to (chat.js asks anyway)
    this.volume = volume;
    this.muted = false;
    this.audio = null;
    this.url = '';
    this.token = 0;
  }

  get speaking() {
    return Boolean(this.audio) || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking);
  }

  configure({ volume, muted } = {}) {
    if (typeof volume === 'number') this.volume = Math.min(1, Math.max(0, volume));
    this.muted = Boolean(muted);
  }

  async say(text, { lang = 'en' } = {}) {
    const token = ++this.token;
    this.stop();
    const clean = String(text || '').trim();
    if (!clean || this.muted) return;
    const res = await this.host.speak({ text: clean, lang }).catch(() => null);
    if (token !== this.token) return; // she stopped, or something new was said
    if (res?.ok && res.audio) {
      const url = URL.createObjectURL(new Blob([bytes(res.audio)], { type: res.mime || 'audio/mpeg' }));
      const audio = new Audio(url);
      audio.volume = this.volume;
      this.audio = audio;
      this.url = url;
      const end = () => {
        if (this.audio === audio) this.finish();
        URL.revokeObjectURL(url);
      };
      audio.addEventListener('ended', end);
      audio.addEventListener('error', () => {
        end();
        this.system(clean, lang, token);
      });
      try {
        await audio.play();
        return;
      } catch {
        end();
      }
    }
    this.system(clean, lang, token);
  }

  // Windows' voice for her language, if it has one (it doesn't for Uzbek: the online ones do).
  system(text, lang, token = this.token) {
    if (typeof speechSynthesis === 'undefined') return;
    if (token !== this.token) return;
    speechSynthesis.cancel();
    const say = new SpeechSynthesisUtterance(text);
    const prefix = (SYSTEM_LANG[lang] || 'en-US').slice(0, 2).toLowerCase();
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) || voices.find((v) => v.default);
    if (voice) say.voice = voice;
    say.lang = voice?.lang || SYSTEM_LANG[lang] || 'en-US';
    say.volume = this.volume;
    speechSynthesis.speak(say);
  }

  finish() {
    this.audio = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
  }

  stop() {
    this.token++;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch { /* already gone */ }
    }
    this.finish();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }
}
