/**
 * Gerador Procedural de Áudio e Efeitos Sonoros com Web Audio API
 * Sem dependências externas de arquivos .mp3/.wav
 */

class SoundEngine {
  private ctx: AudioContext | null = null;
  public enabled: boolean = true;

  private getContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Som de arremesso da linha (whoosh)
   */
  public playCast() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.35);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(300, ctx.currentTime + 0.35);

    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  }

  /**
   * Som de splash da boia na água (plop)
   */
  public playSplash() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  }

  /**
   * Som mecânico do molinete recolhendo linha (click-click)
   */
  public playReel() {
    const ctx = this.getContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(700, ctx.currentTime);
    osc.frequency.setValueAtTime(900, ctx.currentTime + 0.03);

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  }

  /**
   * Som de mordida / alerta de fisgada (Tensão!)
   */
  public playBite() {
    const ctx = this.getContext();
    if (!ctx) return;

    const notes = [440, 660, 880];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.06);

      gain.gain.setValueAtTime(0.18, ctx.currentTime + idx * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.06 + 0.15);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + idx * 0.06);
      osc.stop(ctx.currentTime + idx * 0.06 + 0.15);
    });
  }

  /**
   * Fanfarra de comemoração de acordo com a raridade do peixe
   */
  public playCatch(rarity: number) {
    const ctx = this.getContext();
    if (!ctx) return;

    if (rarity <= 2) {
      // Notas simples em dó maior
      const melody = [523.25, 659.25, 783.99]; // C5, E5, G5
      melody.forEach((freq, i) => {
        this.playTone(ctx, freq, ctx.currentTime + i * 0.1, 0.25, 'triangle', 0.15);
      });
    } else if (rarity <= 4) {
      // Arpejo brilhante
      const melody = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      melody.forEach((freq, i) => {
        this.playTone(ctx, freq, ctx.currentTime + i * 0.09, 0.35, 'triangle', 0.2);
      });
    } else {
      // Fanfarra épica / lendária
      const melody = [440, 554.37, 659.25, 880, 1108.73, 1318.51];
      melody.forEach((freq, i) => {
        this.playTone(ctx, freq, ctx.currentTime + i * 0.08, 0.45, 'sawtooth', 0.18);
      });
    }
  }

  /**
   * Som de sucesso na negociação
   */
  public playTradeSuccess() {
    const ctx = this.getContext();
    if (!ctx) return;
    const chords = [587.33, 739.99, 880.0, 1174.66]; // D, F#, A, D
    chords.forEach((f, idx) => {
      this.playTone(ctx, f, ctx.currentTime + idx * 0.07, 0.3, 'sine', 0.15);
    });
  }

  private playTone(
    ctx: AudioContext,
    freq: number,
    startTime: number,
    duration: number,
    type: OscillatorType = 'sine',
    volume: number = 0.15
  ) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration);
  }
}

export const sound = new SoundEngine();
