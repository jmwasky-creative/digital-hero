const SETTINGS_KEY = "chick-number-blocks:audio";
const EFFECT_KEYS = new Set([
  "ui.tap",
  "block.snap",
  "block.return",
  "count.step",
  "block.drop",
  "answer.correct",
  "answer.retry",
  "build.complete"
]);

const DEFAULT_TRACKS = {
  voice: { enabled: true, volume: 1 },
  effect: { enabled: true, volume: 0.75 },
  music: { enabled: true, volume: 0.15 }
};

const EFFECT_RECIPES = {
  "ui.tap": [[440, 0, 0.06, 0.12]],
  "block.snap": [[260, 0, 0.08, 0.25], [520, 0.07, 0.14, 0.2]],
  "block.return": [[420, 0, 0.12, 0.15], [260, 0.1, 0.18, 0.12]],
  "count.step": [[620, 0, 0.1, 0.18]],
  // A compact, softly damped wooden tap. The quiet upper resonance adds
  // definition without the low two-note "thud" becoming harsh when layered.
  "block.drop": [[360, 0, 0.055, 0.13], [540, 0.004, 0.025, 0.035]],
  "answer.correct": [[523, 0, 0.18, 0.2], [659, 0.12, 0.2, 0.18], [784, 0.24, 0.32, 0.16]],
  "answer.retry": [[330, 0, 0.2, 0.12], [294, 0.18, 0.25, 0.1]],
  "build.complete": [[392, 0, 0.22, 0.14], [523, 0.16, 0.28, 0.14], [659, 0.36, 0.42, 0.13]]
};

function copyTracks(tracks) {
  return Object.fromEntries(
    Object.entries(tracks).map(([name, settings]) => [name, { ...settings }])
  );
}

function clampVolume(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
}

export class AudioManager {
  constructor(environment = globalThis) {
    this.environment = environment;
    this.context = null;
    this.masterGain = null;
    this.effectGain = null;
    this.buffers = new Map();
    this.activeSources = new Set();
    this.lastPlayedAt = new Map();
    this.pendingSpeech = null;
    this.tracks = copyTracks(DEFAULT_TRACKS);
    this.loadSettings();
  }

  loadSettings() {
    try {
      const saved = JSON.parse(this.environment.localStorage?.getItem(SETTINGS_KEY) || "{}");
      for (const track of Object.keys(DEFAULT_TRACKS)) {
        if (saved[track]) this.tracks[track] = {
          enabled: saved[track].enabled !== false,
          volume: clampVolume(saved[track].volume, DEFAULT_TRACKS[track].volume)
        };
      }
    } catch {
      // Defaults are safe when storage is disabled or corrupt.
    }
  }

  saveSettings() {
    try {
      this.environment.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.tracks));
    } catch {
      // Audio remains usable without persistent settings.
    }
  }

  setTrackEnabled(track, enabled) {
    if (!this.tracks[track]) return false;
    this.tracks[track].enabled = Boolean(enabled);
    this.saveSettings();
    if (track === "voice" && !enabled) this.stopSpeech();
    this.applyVolumes();
    return true;
  }

  setTrackVolume(track, volume) {
    if (!this.tracks[track]) return false;
    this.tracks[track].volume = clampVolume(volume);
    this.saveSettings();
    this.applyVolumes();
    return true;
  }

  setSettings(settings = {}) {
    if (!settings || typeof settings !== "object") return this.getSettings();
    for (const track of Object.keys(this.tracks)) {
      const update = settings[track];
      if (typeof update === "boolean") {
        this.tracks[track].enabled = update;
      } else if (update && typeof update === "object") {
        if ("enabled" in update) this.tracks[track].enabled = Boolean(update.enabled);
        if ("volume" in update) {
          this.tracks[track].volume = clampVolume(update.volume, this.tracks[track].volume);
        }
      }
    }
    if (!this.tracks.voice.enabled) this.stopSpeech();
    this.saveSettings();
    this.applyVolumes();
    return this.getSettings();
  }

  getSettings() {
    return copyTracks(this.tracks);
  }

  createContext() {
    if (this.context) return this.context;
    const Context = this.environment.AudioContext || this.environment.webkitAudioContext;
    if (!Context) return null;
    try {
      this.context = new Context();
      this.masterGain = this.context.createGain();
      this.effectGain = this.context.createGain();
      this.effectGain.connect(this.masterGain);
      this.masterGain.connect(this.context.destination);
      this.applyVolumes();
      return this.context;
    } catch {
      this.context = null;
      return null;
    }
  }

  applyVolumes() {
    if (!this.effectGain) return;
    const effect = this.tracks.effect;
    this.effectGain.gain.value = effect.enabled ? effect.volume : 0;
  }

  async unlock() {
    const context = this.createContext();
    if (!context) return false;
    try {
      if (context.state === "suspended") await context.resume();
      // A silent buffer makes iOS commit the user-gesture unlock.
      const buffer = context.createBuffer(1, 1, context.sampleRate);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.masterGain);
      source.start();
      return context.state === "running";
    } catch {
      return false;
    }
  }

  synthesize(key) {
    if (this.buffers.has(key)) return this.buffers.get(key);
    const context = this.createContext();
    const recipe = EFFECT_RECIPES[key];
    if (!context || !recipe) return null;
    const duration = Math.max(...recipe.map((tone) => tone[1] + tone[2])) + 0.03;
    const buffer = context.createBuffer(1, Math.ceil(duration * context.sampleRate), context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (const [frequency, start, length, amplitude] of recipe) {
      const startFrame = Math.floor(start * context.sampleRate);
      const frames = Math.floor(length * context.sampleRate);
      for (let index = 0; index < frames && startFrame + index < channel.length; index += 1) {
        const progress = index / frames;
        const attack = Math.min(1, progress / 0.08);
        const release = Math.pow(1 - progress, 2);
        channel[startFrame + index] +=
          Math.sin(2 * Math.PI * frequency * index / context.sampleRate) *
          amplitude * attack * release;
      }
    }
    this.buffers.set(key, buffer);
    return buffer;
  }

  preload(keys = [...EFFECT_KEYS]) {
    const loaded = [];
    for (const key of keys) {
      if (EFFECT_KEYS.has(key) && this.synthesize(key)) loaded.push(key);
    }
    return loaded;
  }

  playEffect(key) {
    if (!EFFECT_KEYS.has(key) || !this.tracks.effect.enabled) return false;
    const now = this.environment.performance?.now?.() ?? Date.now();
    if (key === "ui.tap" && now - (this.lastPlayedAt.get(key) || 0) < 80) return false;
    if (this.activeSources.size >= 4) return false;
    const context = this.createContext();
    const buffer = this.synthesize(key);
    if (!context || !buffer || context.state !== "running") return false;
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.effectGain);
      source.onended = () => this.activeSources.delete(source);
      this.activeSources.add(source);
      this.lastPlayedAt.set(key, now);
      source.start();
      return true;
    } catch {
      return false;
    }
  }

  stopSpeech() {
    const pending = this.pendingSpeech;
    this.pendingSpeech = null;
    pending?.settle(false);
    try {
      this.environment.speechSynthesis?.cancel();
    } catch {
      // Missing speech synthesis is an expected browser fallback.
    }
  }

  createUtterance(text, options = {}) {
    const Utterance = this.environment.SpeechSynthesisUtterance;
    if (!Utterance || !text) return null;
    const utterance = new Utterance(String(text));
    utterance.lang = options.lang || "zh-CN";
    utterance.rate = options.rate ?? 0.82;
    utterance.pitch = options.pitch ?? 1.08;
    utterance.volume = this.tracks.voice.volume;
    return utterance;
  }

  speak(text, options = {}) {
    const synthesis = this.environment.speechSynthesis;
    if (!this.tracks.voice.enabled || !synthesis) return false;
    try {
      const utterance = this.createUtterance(text, options);
      if (!utterance) return false;
      this.stopSpeech();
      synthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  speakAndWait(text, options = {}) {
    const synthesis = this.environment.speechSynthesis;
    if (!this.tracks.voice.enabled || !synthesis) return Promise.resolve(false);

    let utterance;
    try {
      utterance = this.createUtterance(text, options);
    } catch {
      return Promise.resolve(false);
    }
    if (!utterance) return Promise.resolve(false);

    this.stopSpeech();
    return new Promise((resolve) => {
      let settled = false;
      const pending = {
        utterance,
        settle: (completed) => {
          if (settled) return;
          settled = true;
          if (this.pendingSpeech === pending) this.pendingSpeech = null;
          resolve(completed);
        }
      };
      this.pendingSpeech = pending;
      utterance.onend = () => pending.settle(true);
      utterance.onerror = () => pending.settle(false);
      try {
        synthesis.speak(utterance);
      } catch {
        pending.settle(false);
      }
    });
  }

  speakNumber(number, options = {}) {
    if (!Number.isFinite(Number(number))) return false;
    return this.speak(String(Number(number)), options);
  }

  readNumber(number, options = {}) {
    return this.speakNumber(number, options);
  }

  readTask(task) {
    if (typeof task === "string") return this.speak(task);
    if (!task || typeof task !== "object") return false;
    if (task.voiceText || task.prompt) return this.speak(task.voiceText || task.prompt);
    const current = task.current ?? task.currentValue;
    const target = task.target ?? task.targetValue;
    if (current !== undefined && target !== undefined) {
      return this.speak(`现在有${current}块积木，目标是${target}块。`);
    }
    return false;
  }

  destroy() {
    this.stopSpeech();
    for (const source of this.activeSources) {
      try { source.stop(); } catch {}
    }
    this.activeSources.clear();
    this.context?.close?.();
    this.context = null;
    this.buffers.clear();
  }
}

export const audioManager = new AudioManager();
export default audioManager;
