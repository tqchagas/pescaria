import { FishingState } from '../shared/types.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
}

export class FishingGameCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: FishingState = 'IDLE';

  // Dimensões lógicas
  private width: number = 800;
  private height: number = 500;

  // Animações e tempo
  private time: number = 0;
  private lastTime: number = 0;
  private particles: Particle[] = [];

  // Posições dos elementos de jogo
  private dockX: number = 100;
  private dockY: number = 320;
  private rodTipX: number = 180;
  private rodTipY: number = 230;

  // Boia
  private bobberX: number = 480;
  private bobberY: number = 350;
  private bobberTargetX: number = 480;
  private bobberTargetY: number = 350;
  private bobberStartY: number = 230;
  private castProgress: number = 0;

  // Peixe saltando (na fase CAUGHT)
  private jumpingFishProgress: number = 0;
  private jumpingFishColor: string = '#0ea5e9';

  // Nuvens
  private clouds: Array<{ x: number; y: number; speed: number; scale: number }> = [
    { x: 50, y: 60, speed: 12, scale: 0.8 },
    { x: 260, y: 90, speed: 8, scale: 1.1 },
    { x: 520, y: 50, speed: 10, scale: 0.9 },
    { x: 700, y: 80, speed: 15, scale: 0.7 },
  ];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.handleResize();
    window.addEventListener('resize', () => this.handleResize());
    this.startLoop();
  }

  public setState(newState: FishingState, fishColor: string = '#0ea5e9') {
    this.state = newState;
    if (newState === 'CASTING') {
      this.castProgress = 0;
      this.bobberX = this.rodTipX;
      this.bobberY = this.rodTipY;
    } else if (newState === 'REELING') {
      this.createSplash(this.bobberX, this.waterY(this.bobberX));
    } else if (newState === 'CAUGHT') {
      this.jumpingFishProgress = 0;
      this.jumpingFishColor = fishColor;
      this.createSplash(this.bobberX, this.waterY(this.bobberX), 35);
    }
  }

  private handleResize() {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width || 800;
    const h = Math.min(520, Math.max(380, window.innerHeight * 0.48));

    this.width = w;
    this.height = h;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);

    // Ajustar proporções relativas
    this.dockX = Math.max(60, this.width * 0.12);
    this.dockY = this.height * 0.65;
    this.rodTipX = this.dockX + 110;
    this.rodTipY = this.dockY - 110;

    this.bobberTargetX = this.width * 0.62;
    this.bobberTargetY = this.height * 0.70;
  }

  private waterY(x: number): number {
    const base = this.height * 0.65;
    const wave1 = Math.sin(x * 0.015 + this.time * 2.2) * 5;
    const wave2 = Math.cos(x * 0.03 - this.time * 1.5) * 3;
    return base + wave1 + wave2;
  }

  private startLoop() {
    const tick = (now: number) => {
      const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0.016;
      this.lastTime = now;
      this.time += dt;

      this.update(dt);
      this.render();

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private update(dt: number) {
    // 1. Atualizar nuvens
    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x > this.width + 120) {
        c.x = -120;
      }
    }

    // 2. Atualizar partículas
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 320 * dt; // gravidade
      p.life += dt;
      p.alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
      }
    }

    // 3. Atualizar estados da boia e do arremesso
    if (this.state === 'IDLE') {
      this.bobberX = this.rodTipX;
      this.bobberY = this.rodTipY + 25 + Math.sin(this.time * 2) * 4;
    } else if (this.state === 'CASTING') {
      this.castProgress = Math.min(1, this.castProgress + dt * 1.1);
      // Movimento balístico parabólico
      const t = this.castProgress;
      const startX = this.rodTipX;
      const startY = this.rodTipY;
      const endX = this.bobberTargetX;
      const endY = this.waterY(endX);

      this.bobberX = startX + (endX - startX) * t;
      const arcHeight = 120;
      this.bobberY = startY + (endY - startY) * t - Math.sin(t * Math.PI) * arcHeight;

      if (t >= 0.99) {
        this.createSplash(this.bobberX, this.waterY(this.bobberX));
      }
    } else if (this.state === 'REELING') {
      this.bobberX = this.bobberTargetX;
      // Boia flutua e treme se estiver ocorrendo mordida
      const currentWater = this.waterY(this.bobberX);
      const biteTremble = Math.sin(this.time * 25) * 4;
      this.bobberY = currentWater + biteTremble;

      if (Math.random() < 0.08) {
        this.createRipple(this.bobberX, currentWater);
      }
    } else if (this.state === 'CAUGHT') {
      this.jumpingFishProgress = Math.min(1, this.jumpingFishProgress + dt * 1.0);
      this.bobberX = this.bobberTargetX - 30 * this.jumpingFishProgress;
      this.bobberY = this.waterY(this.bobberX);
    }
  }

  private render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawSky();
    this.drawMountains();
    this.drawSun();
    this.drawClouds();
    this.drawWater();
    this.drawDockAndFisherman();
    this.drawFishingLine();
    this.drawBobber();
    this.drawJumpingFish();
    this.drawParticles();
    this.drawHUDState();
  }

  private drawSky() {
    const ctx = this.ctx;
    const skyGrad = ctx.createLinearGradient(0, 0, 0, this.height * 0.7);
    skyGrad.addColorStop(0, '#38bdf8'); // Azul céu claro
    skyGrad.addColorStop(0.5, '#7dd3fc');
    skyGrad.addColorStop(1, '#fed7aa'); // Toque alaranjado suave no horizonte
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawSun() {
    const ctx = this.ctx;
    const sunX = this.width * 0.78;
    const sunY = this.height * 0.22;

    // Brilho solar
    const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 70);
    glow.addColorStop(0, 'rgba(254, 240, 138, 0.8)');
    glow.addColorStop(0.5, 'rgba(253, 224, 71, 0.3)');
    glow.addColorStop(1, 'rgba(253, 224, 71, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 70, 0, Math.PI * 2);
    ctx.fill();

    // Disco do Sol
    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 26, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawMountains() {
    const ctx = this.ctx;
    const baseY = this.height * 0.65;

    // Montanhas de fundo distantes
    ctx.fillStyle = '#bae6fd';
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(this.width * 0.25, baseY - 90);
    ctx.lineTo(this.width * 0.5, baseY - 50);
    ctx.lineTo(this.width * 0.75, baseY - 110);
    ctx.lineTo(this.width, baseY - 60);
    ctx.lineTo(this.width, baseY);
    ctx.closePath();
    ctx.fill();

    // Montanhas médias verdes
    ctx.fillStyle = '#86efac';
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(this.width * 0.18, baseY - 50);
    ctx.lineTo(this.width * 0.38, baseY - 30);
    ctx.lineTo(this.width * 0.65, baseY - 65);
    ctx.lineTo(this.width * 0.88, baseY - 40);
    ctx.lineTo(this.width, baseY - 20);
    ctx.lineTo(this.width, baseY);
    ctx.closePath();
    ctx.fill();
  }

  private drawClouds() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    for (const c of this.clouds) {
      this.drawCloud(c.x, c.y, c.scale);
    }
  }

  private drawCloud(x: number, y: number, scale: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.arc(20, -6, 24, 0, Math.PI * 2);
    ctx.arc(42, 0, 18, 0, Math.PI * 2);
    ctx.arc(20, 10, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawWater() {
    const ctx = this.ctx;
    const waterBase = this.height * 0.65;

    // Camada profunda da água
    const waterGrad = ctx.createLinearGradient(0, waterBase, 0, this.height);
    waterGrad.addColorStop(0, '#0284c7');
    waterGrad.addColorStop(0.35, '#0369a1');
    waterGrad.addColorStop(1, '#082f49');

    ctx.fillStyle = waterGrad;
    ctx.beginPath();
    ctx.moveTo(0, this.height);
    ctx.lineTo(0, waterBase);

    // Ondas senoidais
    for (let x = 0; x <= this.width; x += 10) {
      ctx.lineTo(x, this.waterY(x));
    }

    ctx.lineTo(this.width, this.height);
    ctx.closePath();
    ctx.fill();

    // Espuma e brilho na superfície da água
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= this.width; x += 8) {
      const y = this.waterY(x);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Reflexos aquáticos
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    for (let i = 0; i < 6; i++) {
      const rx = (this.width * 0.3 + i * 85 + Math.sin(this.time + i) * 20) % this.width;
      const ry = waterBase + 25 + i * 18;
      ctx.fillRect(rx, ry, 45, 2.5);
    }
  }

  private drawDockAndFisherman() {
    const ctx = this.ctx;

    // 1. Pilares do trapiche de madeira
    ctx.fillStyle = '#5c3a21';
    for (let i = 0; i < 3; i++) {
      const px = this.dockX - 45 + i * 40;
      ctx.fillRect(px, this.dockY - 5, 14, this.height - this.dockY + 20);
    }

    // 2. Prancha superior do trapiche
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(this.dockX - 80, this.dockY - 14, 150, 14);
    ctx.fillStyle = '#6e441f';
    ctx.fillRect(this.dockX - 80, this.dockY, 150, 4);

    // 3. Pescador estilizado (silhueta simpática)
    const px = this.dockX + 25;
    const py = this.dockY - 14;

    // Pernas sentadas no trapiche
    ctx.fillStyle = '#1e3a8a';
    ctx.fillRect(px - 14, py - 20, 26, 20);

    // Tronco / Casaco
    ctx.fillStyle = '#ea580c'; // Colete alaranjado
    ctx.beginPath();
    ctx.roundRect(px - 16, py - 52, 28, 34, 6);
    ctx.fill();

    // Cabeça
    ctx.fillStyle = '#fbcfe8';
    ctx.beginPath();
    ctx.arc(px - 2, py - 60, 11, 0, Math.PI * 2);
    ctx.fill();

    // Chapéu de pescador
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.ellipse(px - 2, py - 68, 19, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - 2, py - 70, 10, Math.PI, Math.PI * 2);
    ctx.fill();

    // Braços segurando a vara
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px + 4, py - 40);
    ctx.lineTo(px + 22, py - 34);
    ctx.stroke();

    // 4. Vara de Pescar
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(px + 10, py - 25);

    // Flexão da vara de acordo com o estado
    let tipBendX = 0;
    let tipBendY = 0;
    if (this.state === 'REELING') {
      tipBendX = 15;
      tipBendY = 22 + Math.sin(this.time * 20) * 3; // Vergando e tremendo com o peixe
    } else if (this.state === 'CAUGHT') {
      tipBendX = -10;
      tipBendY = -15; // Puxando pra cima com força
    }

    const tipX = this.rodTipX + tipBendX;
    const tipY = this.rodTipY + tipBendY;

    ctx.quadraticCurveTo(px + 60, py - 65, tipX, tipY);
    ctx.stroke();

    // Carretilha / Molinete
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(px + 14, py - 28, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawFishingLine() {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.2;

    const startX = this.rodTipX + (this.state === 'REELING' ? 15 : 0);
    const startY = this.rodTipY + (this.state === 'REELING' ? 22 : 0);

    ctx.beginPath();
    ctx.moveTo(startX, startY);

    if (this.state === 'IDLE') {
      // Linha pendurada solta
      ctx.quadraticCurveTo(startX + 8, startY + 15, this.bobberX, this.bobberY);
    } else if (this.state === 'CASTING') {
      // Linha esticando no ar
      ctx.lineTo(this.bobberX, this.bobberY);
    } else if (this.state === 'REELING') {
      // Linha tensionada vibrando
      const midX = (startX + this.bobberX) / 2;
      const midY = (startY + this.bobberY) / 2 + Math.sin(this.time * 30) * 2;
      ctx.lineTo(midX, midY);
      ctx.lineTo(this.bobberX, this.bobberY);
    } else {
      ctx.lineTo(this.bobberX, this.bobberY);
    }

    ctx.stroke();
  }

  private drawBobber() {
    if (this.state === 'IDLE') return;

    const ctx = this.ctx;
    const bx = this.bobberX;
    const by = this.bobberY;

    // Haste amarela da boia
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by - 12);
    ctx.lineTo(bx, by - 2);
    ctx.stroke();

    // Corpo esférico da boia: metade superior vermelha, inferior branca
    // Metade superior
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(bx, by, 7, Math.PI, Math.PI * 2);
    ctx.fill();

    // Metade inferior
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, Math.PI);
    ctx.fill();

    // Borda preta fina
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawJumpingFish() {
    if (this.state !== 'CAUGHT') return;

    const ctx = this.ctx;
    const p = this.jumpingFishProgress;
    if (p <= 0 || p >= 1) return;

    // Salto parabólico elegante
    const startX = this.bobberTargetX;
    const startY = this.waterY(startX);
    const jumpApexY = startY - 140;

    const currentX = startX - p * 70;
    const currentY = startY - Math.sin(p * Math.PI) * 140;

    ctx.save();
    ctx.translate(currentX, currentY);

    // Rotação dinâmica acompanhando a trajetória do salto
    const angle = (p - 0.5) * Math.PI * 0.9;
    ctx.rotate(angle);

    // Desenho estilizado do peixe saltando
    // Corpo
    ctx.fillStyle = this.jumpingFishColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, 24, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // Cauda
    ctx.fillStyle = this.jumpingFishColor;
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(34, -12);
    ctx.lineTo(30, 0);
    ctx.lineTo(34, 12);
    ctx.closePath();
    ctx.fill();

    // Barbatana dorsal
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-4, -10);
    ctx.lineTo(8, -18);
    ctx.lineTo(12, -8);
    ctx.closePath();
    ctx.fill();

    // Olho
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-14, -3, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(-15, -3, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawHUDState() {
    const ctx = this.ctx;
    ctx.save();

    // Badge sutil no canto superior esquerdo com status
    let label = '🎣 Pronto para lançar';
    let color = '#38bdf8';

    if (this.state === 'CASTING') {
      label = '🌊 Lançando a linha...';
      color = '#eab308';
    } else if (this.state === 'REELING') {
      label = '⚡ Fisgando peixe... Segura!';
      color = '#f97316';
    } else if (this.state === 'CAUGHT') {
      label = '✨ Peixe fisgado com sucesso!';
      color = '#22c55e';
    } else if (this.state === 'INVENTORY_ACTION') {
      label = '🎒 Recompensa obtida';
      color = '#a855f7';
    }

    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.beginPath();
    ctx.roundRect(16, 16, 240, 36, 18);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32, 34, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    ctx.fillText(label, 46, 38);

    ctx.restore();
  }

  public createSplash(x: number, y: number, count: number = 20) {
    for (let i = 0; i < count; i++) {
      const angle = Math.PI + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 80 + Math.random() * 160;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 2 + Math.random() * 3.5,
        color: 'rgba(224, 242, 254, 0.9)',
        alpha: 1,
        life: 0,
        maxLife: 0.4 + Math.random() * 0.4,
      });
    }
  }

  public createRipple(x: number, y: number) {
    for (let i = 0; i < 2; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 16,
        y: y + (Math.random() - 0.5) * 4,
        vx: (Math.random() - 0.5) * 20,
        vy: 0,
        radius: 3 + Math.random() * 4,
        color: 'rgba(255, 255, 255, 0.35)',
        alpha: 0.8,
        life: 0,
        maxLife: 0.6,
      });
    }
  }
}
