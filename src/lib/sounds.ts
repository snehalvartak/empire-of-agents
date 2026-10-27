/**
 * Tiny synthesized sound effects via the Web Audio API — no audio files.
 * Each effect is a short envelope-shaped oscillator blip. Respects a
 * localStorage-persisted mute flag; audio context resumes on first gesture.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function blip(freq: number, duration: number, type: OscillatorType, gain: number, delay = 0) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  const t0 = ac.currentTime + delay;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function isMuted(): boolean {
  try {
    return localStorage.getItem('soundOn') === 'off';
  } catch {
    return false;
  }
}

export function soundOn(): boolean {
  return !isMuted();
}

export function setSoundOn(on: boolean) {
  try {
    localStorage.setItem('soundOn', on ? 'on' : 'off');
  } catch {
    /* private mode */
  }
}

/** One-shot effect for a chronicle event type. No-op when muted. */
export function playEventSound(type: string) {
  if (isMuted()) return;
  switch (type) {
    case 'build':
      blip(220, 0.18, 'square', 0.05);
      blip(330, 0.22, 'square', 0.04, 0.09);
      break;
    case 'gather':
      blip(660, 0.08, 'triangle', 0.035);
      break;
    case 'deposit':
      blip(440, 0.07, 'triangle', 0.03);
      blip(550, 0.07, 'triangle', 0.03, 0.07);
      break;
    case 'advance_age':
      blip(392, 0.15, 'sawtooth', 0.045);
      blip(523, 0.15, 'sawtooth', 0.045, 0.13);
      blip(659, 0.3, 'sawtooth', 0.05, 0.26);
      break;
    case 'discover':
      blip(784, 0.12, 'sine', 0.045);
      blip(988, 0.2, 'sine', 0.045, 0.1);
      break;
    case 'level_up':
      blip(523, 0.1, 'sine', 0.04);
      blip(659, 0.1, 'sine', 0.04, 0.09);
      blip(784, 0.18, 'sine', 0.04, 0.18);
      break;
    case 'chat':
      blip(587, 0.06, 'sine', 0.028);
      blip(494, 0.06, 'sine', 0.028, 0.08);
      break;
    case 'system':
      blip(196, 0.25, 'sine', 0.03);
      break;
    default:
      break;
  }
}
