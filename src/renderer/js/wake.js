// Her ears when your hands are busy: the microphone stays open, she listens for her name ("Capri"),
// then for what you ask. The words go through voice.js in main, as with the microphone button; only
// what passes the local voice detector is written down.

const FRAME_MS = 60;
const SILENCE_MS = 850;   // a pause this long ends what you were saying
const MIN_MS = 350;       // shorter than this, it was a knock on the table
const MAX_MS = 12000;
const WAIT_MS = 12000;    // after "Capri", how long she waits for the ask
const FLOOR = 0.012;      // never quieter than this, however quiet the room gets
// Whisper's spelling of her name, in the languages she knows
const WAKE = /(?:^|[^\p{L}])(capri|kapri|kepri|капри|кэпри|кепри|капрі)(?=$|[^\p{L}])/iu;
// A button on screen, answered out loud: "yes" clicks the main one, "no" the way out of it.
const YES = /^(?:да|ага|конечно|давай|ок|окей|хорошо|yes|yeah|yep|yup|sure|ok|okay|oui|ouais|sí|si|claro|sim|ha|xo[‘ʻ'’]?p|xop|mayli|bo[‘ʻ'’]?ladi)$/i;
const NO = /^(?:нет|неа|no|nope|non|yo[‘ʻ'’]?q|yoq|não|nao)$/i;

// What came after her name, or null if she wasn't called: "" for a bare "Capri".
export function heardName(text) {
  const whole = String(text || '');
  const m = WAKE.exec(whole);
  if (!m) return null;
  return whole.slice(m.index + m[0].length).replace(/^[\s,.:;!?—–-]+/, '').trim();
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export class Wake {
  constructor({ host, chat, speaker }) {
    this.host = host;
    this.chat = chat;
    this.speaker = speaker;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.timer = 0;
    this.floor = 0.006;  // the room as she last heard it quiet
    this.hot = 0;        // frames in a row over the threshold
    this.recording = null;
    this.started = 0;
    this.quietSince = 0;
    this.hearing = false;
    this.spokeAt = 0;    // when she last talked: her own voice comes back through the microphone
    this.drop = false;   // the segment in hand is her voice, not yours
    this.mode = 'idle';  // 'idle': for her name; 'ask': for what you want
    this.until = 0;
  }

  get lang() {
    return this.chat.brain.lang;
  }

  async start() {
    if (this.stream) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false;
    }
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.timer = setInterval(() => this.frame(), FRAME_MS);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.stopRecord();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.mode = 'idle';
  }

  // Every 60 ms: is someone talking over her quiet room?
  frame() {
    if (!this.stream) return;
    if (this.chat.mic || this.hearing) return; // you on the button, or a turn already on its way
    if (this.speaker?.speaking) {
      this.spokeAt = performance.now();
      if (this.recording) {
        this.drop = true; // what is recorded from here is her, not you
        this.stopRecord();
      }
      return;
    }
    if (this.spokeAt && performance.now() - this.spokeAt < 1200) return; // the room still rings with her
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    const rms = Math.sqrt(sum / this.samples.length);
    const loud = Math.max(FLOOR, this.floor * 5);
    const now = performance.now();
    if (rms < loud * 0.8) this.floor = this.floor * 0.97 + rms * 0.03;
    this.hot = rms > loud ? this.hot + 1 : 0;

    if (!this.recording) {
      if (this.hot >= 3) this.record(now);
      else if (this.mode === 'ask' && now > this.until) this.mode = 'idle'; // nothing came: she goes back to waiting for her name
      return;
    }
    if (rms > loud * 0.8) this.quietSince = 0;
    else if (!this.quietSince) this.quietSince = now;
    const spoken = now - this.started;
    const done = this.quietSince && now - this.quietSince >= SILENCE_MS && spoken >= MIN_MS;
    if (done || spoken >= MAX_MS) this.stopRecord();
  }

  record(now) {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .find((m) => window.MediaRecorder?.isTypeSupported?.(m));
    let recorder;
    try {
      recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    } catch {
      return;
    }
    const chunks = [];
    recorder.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    recorder.addEventListener('stop', () => this.hear(chunks, recorder.mimeType || mime || 'audio/webm'));
    this.recording = recorder;
    this.started = now;
    this.quietSince = 0;
    this.hot = 0;
    recorder.start(250);
  }

  stopRecord() {
    const recorder = this.recording;
    this.recording = null;
    this.quietSince = 0;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async hear(chunks, mime) {
    if (this.drop) {
      this.drop = false; // this one was her own voice
      return;
    }
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 1400) return; // a click, a cough
    if (this.speaker?.speaking) return; // her own voice through the speakers
    this.hearing = true;
    let res;
    try {
      const audio = base64(await blob.arrayBuffer());
      res = await this.host.transcribe({ audio, mime, lang: this.lang });
    } catch {
      res = null;
    } finally {
      this.hearing = false;
    }
    if (!res?.ok) return;
    this.words(String(res.text || '').trim());
  }

  words(text) {
    if (!text) return;
    if (this.confirm(text)) return;
    const rest = heardName(text);
    if (this.mode === 'idle') {
      if (rest !== null) this.wake(rest);
      return;
    }
    if (rest) {
      if (rest.length < 2) this.again(); // her name again: she asks once more
      else this.wake(rest);
      return;
    }
    this.wake(text);
  }

  // She asked something with buttons ("…: close Spotify?"): a spoken yes or no answers it.
  confirm(text) {
    const actions = this.chat.panel?.current?.actions || [];
    if (!actions.length) return false;
    const said = String(text).trim().replace(/[.!?,;:…]+$/, '');
    if (YES.test(said)) {
      this.chat.panel.choose((actions.find((a) => a.primary) || actions[0]).id);
      return true;
    }
    if (NO.test(said)) {
      const out = actions.find((a) => a.id === 'no' || a.id === 'leave');
      if (out) this.chat.panel.choose(out.id);
      else this.chat.panel.setActions([]);
      return true;
    }
    return false;
  }

  async wake(rest) {
    if (this.chat.turn) return; // she is already answering: say it after
    if (rest) {
      this.mode = 'idle';
      await this.ask(rest);
      return;
    }
    this.mode = 'ask';
    this.until = performance.now() + WAIT_MS;
    const t = this.chat.brain.t.chat;
    if (!this.chat.open) await this.chat.start();
    if (!this.chat.open) {
      this.mode = 'idle'; // her setup took the stage: nothing to ask into
      return;
    }
    this.chat.capri.perform('hop');
    this.chat.interject(t.wakeHi, [], null);
    this.chat.panel.setFace('look');
    this.speaker?.say(t.wakeHi, { lang: this.lang });
  }

  async again() {
    const t = this.chat.brain.t.chat;
    this.until = performance.now() + WAIT_MS;
    if (this.chat.open) this.chat.interject(t.wakeHi, [], null);
    this.speaker?.say(t.wakeHi, { lang: this.lang });
  }

  async ask(text) {
    if (!this.chat.open) await this.chat.start();
    if (!this.chat.open || this.chat.turn) return;
    this.chat.send(text, { voice: true });
  }
}
