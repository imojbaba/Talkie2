/*
 * Capture worklet: resamples mic input from the context rate (44.1/48 kHz)
 * down to 16 kHz mono and posts 320-sample (20 ms) Int16 frames to the main
 * thread. Gated by {active} messages so nothing leaves the worklet unless the
 * PTT button is held.
 */
class PTTCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = 16000;
    this.ratio = sampleRate / this.target;
    this.fifo = new Float32Array(0);
    this.pos = 0;
    this.frame = new Int16Array(320);
    this.fill = 0;
    this.active = false;
    this.port.onmessage = (e) => {
      if (e.data && 'active' in e.data) {
        this.active = !!e.data.active;
        if (!this.active) {
          this.fifo = new Float32Array(0);
          this.pos = 0;
          this.fill = 0;
        }
      }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !this.active) return true;
    const merged = new Float32Array(this.fifo.length + ch.length);
    merged.set(this.fifo, 0);
    merged.set(ch, this.fifo.length);
    let pos = this.pos;
    // Linear-interpolation downsample; needs one sample of lookahead.
    while (pos + 1 < merged.length) {
      const i = pos | 0;
      const frac = pos - i;
      const s = merged[i] + (merged[i + 1] - merged[i]) * frac;
      const v = Math.max(-1, Math.min(1, s));
      this.frame[this.fill++] = (v * 32767) | 0;
      if (this.fill === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.fill = 0;
      }
      pos += this.ratio;
    }
    const drop = Math.min(pos | 0, merged.length);
    this.fifo = merged.slice(drop);
    this.pos = pos - drop;
    return true;
  }
}

registerProcessor('ptt-capture', PTTCapture);
