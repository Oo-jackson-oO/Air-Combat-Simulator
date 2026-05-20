class AudioManager {
  private ctx: AudioContext | null = null;
  
  public init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public playShootSound() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(800, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + 0.1);
    
    gainNode.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
    
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  }

  public playDashSound() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(400, this.ctx.currentTime + 0.1);
    osc.frequency.linearRampToValueAtTime(50, this.ctx.currentTime + 0.3);
    
    gainNode.gain.setValueAtTime(0.4, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);
    
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + 0.3);
  }

  public playExplosionSound() {
    if (!this.ctx) return;
    
    const bufferSize = this.ctx.sampleRate * 0.5; // 0.5 seconds
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(100, this.ctx.currentTime + 0.5);
    
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.5, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.5);
    
    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    noise.start();
  }

  public playBossExplosionSound() {
    if (!this.ctx) return;
    
    const dur = 3.0; // long explosion

    // Sub-bass rumble
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(10, this.ctx.currentTime + dur);
    
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);

    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + dur);

    // Noise burst
    const bufferSize = this.ctx.sampleRate * dur;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.max(0, 1 - i/bufferSize); // fading noise
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, this.ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(100, this.ctx.currentTime + dur);
    
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(1.5, this.ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);
    
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.ctx.destination);
    
    noise.start();
  }

  public playBossWarningSound() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(400, this.ctx.currentTime + i * 1.0);
        osc.frequency.setValueAtTime(800, this.ctx.currentTime + i * 1.0 + 0.2);
        
        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.0, this.ctx.currentTime);
        gainNode.gain.setValueAtTime(0.2, this.ctx.currentTime + i * 1.0);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + i * 1.0 + 0.4);
        
        osc.connect(gainNode);
        gainNode.connect(this.ctx.destination);
        osc.start(this.ctx.currentTime + i * 1.0);
        osc.stop(this.ctx.currentTime + i * 1.0 + 0.5);
    }
  }
}


export const audioManager = new AudioManager();
