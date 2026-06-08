import React, { useEffect, useRef, useState } from 'react';
import { GameEngine } from '../game/controller';
import { GameViewSnapshot, NetworkHudSnapshot } from '../game/interfaces';
import { Radar, Crosshair, AlertTriangle } from 'lucide-react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

function getConnectionLabel(network: NetworkHudSnapshot): string {
  switch (network.connectionState) {
    case 'connecting':
      return '连接中';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
    case 'error':
      return '连接异常';
    default:
      return '待连接';
  }
}

function getSyncLabel(network: NetworkHudSnapshot): string {
  switch (network.syncState) {
    case 'waiting_room':
      return '房间等待中';
    case 'syncing':
      return '同步中';
    case 'live':
      return '已同步';
    case 'stale':
      return '快照超时';
    case 'disconnected':
      return '已失联';
    default:
      return '加入房间中';
  }
}

function getStatusColor(state: NetworkHudSnapshot['connectionState'] | NetworkHudSnapshot['syncState']): string {
  if (state === 'connected' || state === 'live') return 'text-emerald-400';
  if (state === 'connecting' || state === 'syncing' || state === 'waiting_room' || state === 'joining') return 'text-amber-400';
  return 'text-red-400';
}

export default function AirCombatPlatform({ onGameOver }: { onGameOver: (score: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewSnapshot, setViewSnapshot] = useState<GameViewSnapshot | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  // Use a ref to store engine so it persists across renders but can be recreated on mount
  const engineRef = useRef<GameEngine | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const shakeRef = useRef<number>(0);

  useEffect(() => {
    if (!canvasRef.current) return;
    let engine: GameEngine;
    try {
      engine = new GameEngine();
    } catch (error) {
      const message = error instanceof Error ? error.message : '联网初始化失败';
      setFatalError(message);
      return;
    }
    engineRef.current = engine;
    engine.input.attachCanvas(canvasRef.current);
    engine.onSnapshotUpdated = (snap) => {
      setViewSnapshot(snap);
      if (snap.game.status === 'defeat') {
        engine.stop?.(); // assuming we might want to stop it
      }
    };
    engine.onExplosion = (x, y) => {
      shakeRef.current = 15; // Set shake intensity
      const newParticles: Particle[] = [];
      for (let i = 0; i < 40; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 200 + 50;
        newParticles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1.0,
          maxLife: 0.5 + Math.random() * 0.8,
          color: Math.random() > 0.5 ? '#f97316' : '#ef4444',
          size: Math.random() * 5 + 2
        });
      }
      particlesRef.current.push(...newParticles);
    };
    engine.onBossExplosion = (x, y) => {
      shakeRef.current = 50; // Mega screen shake
      const newParticles: Particle[] = [];
      // Core flash
      for (let i = 0; i < 300; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 800 + 100;
        newParticles.push({
          x, y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1.0,
          maxLife: 1.5 + Math.random() * 1.5,
          color: Math.random() > 0.8 ? '#ffffff' : (Math.random() > 0.4 ? '#3b82f6' : '#60a5fa'),
          size: Math.random() * 15 + 5
        });
      }
      particlesRef.current.push(...newParticles);
    };
    engine.start();

    // The Render Loop (Separation of concern: Pure rendering based on snapshot)
    let animationId: number;
    let lastTime = performance.now();

    const render = (timestamp: number) => {
      const dt = (timestamp - lastTime) / 1000;
      lastTime = timestamp;
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && canvasRef.current && engineRef.current) {
        const snap = engineRef.current.getViewSnapshot().game;
        const canvas = canvasRef.current;
        const width = canvas.width;
        const height = canvas.height;

        // Apply global screen shake
        ctx.save();
        if (shakeRef.current > 0) {
          const magnitude = shakeRef.current;
          const dx = (Math.random() - 0.5) * magnitude;
          const dy = (Math.random() - 0.5) * magnitude;
          ctx.translate(dx, dy);
          shakeRef.current = Math.max(0, shakeRef.current - 60 * dt); // actually real dt should be used here, but visually fine
        }

        let camX = width / 2;
        let camY = height / 2;
        if (snap.player) {
          camX = snap.player.x;
          camY = snap.player.y;
        }

        // Cinematic Zoom & Pan Effect
        if (snap.cinematicFocus) {
          const { x, y, timer, maxTimer } = snap.cinematicFocus;
          // Progress goes from 0 to 1 and back to 0
          const p = 1.0 - Math.abs(timer - (maxTimer / 2)) / (maxTimer / 2);
          // clamp and ease
          const ease = Math.max(0, Math.min(1, p * p * (3 - 2 * p))); // smoothstep
          const targetScale = 1 + ease * 1.5; // Zoom up to 2.5x

          ctx.translate(width / 2, height / 2);
          ctx.scale(targetScale, targetScale);
          ctx.translate(-width / 2, -height / 2);

          // Pan camera towards the focus
          camX = camX + (x - camX) * ease;
          camY = camY + (y - camY) * ease;
        }

        // 1. Draw Ocean Background
        ctx.fillStyle = '#0f172a'; // Deep water blue
        // Fill larger area due to potential zooms and camera movement
        ctx.fillRect(-width, -height, width * 3, height * 3);

        ctx.save();
        // Camera centers on player or cinematic focus
        ctx.translate(width / 2 - camX, height / 2 - camY);

        // 2. Draw map grid/boundaries
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 2;
        const gridSize = 200;
        for (let x = 0; x < snap.mapBounds.width; x += gridSize) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, snap.mapBounds.height); ctx.stroke();
        }
        for (let y = 0; y < snap.mapBounds.height; y += gridSize) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(snap.mapBounds.width, y); ctx.stroke();
        }
        ctx.strokeStyle = '#ef4444'; ctx.strokeRect(0, 0, snap.mapBounds.width, snap.mapBounds.height);

        // 3. Draw Radar Range of AWACS / Player
        if (snap.player) {
          ctx.beginPath();
          ctx.arc(snap.player.x, snap.player.y, snap.radarRange, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(16, 185, 129, 0.05)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.2)';
          ctx.stroke();
        }

        // Helper to draw a jet
        const drawJet = (x: number, y: number, heading: number, color: string, scale = 1, isBoss = false) => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(heading);
          ctx.scale(scale, scale);
          ctx.beginPath();
          if (isBoss) {
            // Draw a stealth bomber shape facing right
            ctx.moveTo(25, 0); // Nose
            ctx.lineTo(-10, 30); // Right wing tip
            ctx.lineTo(-5, 10);
            ctx.lineTo(-15, 0);  // Tail center
            ctx.lineTo(-5, -10);
            ctx.lineTo(-10, -30); // Left wing tip
            ctx.closePath();
          } else {
            ctx.moveTo(20, 0); // Nose
            ctx.lineTo(-15, 15); // Right wing
            ctx.lineTo(-10, 0); // Tail
            ctx.lineTo(-15, -15); // Left wing
            ctx.closePath();
          }
          ctx.fillStyle = color;
          ctx.fill();
          // Thruster
          ctx.fillStyle = '#f97316';
          if (isBoss) {
            ctx.beginPath(); ctx.arc(-20, 8, 5 + Math.random() * 5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(-20, -8, 5 + Math.random() * 5, 0, Math.PI * 2); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(-12, 0, 4 + Math.random() * 4, 0, Math.PI * 2); ctx.fill();
          }
          ctx.restore();
        };

        // 4. Draw Enemies
        snap.enemies.forEach(e => {
          if (e.inRadarRange || e.isBoss) {
            drawJet(e.x, e.y, e.heading, '#3b82f6', e.isBoss ? 2 : 0.8, e.isBoss); // Boss/Enemy is Blue
            // HP Bar
            ctx.fillStyle = '#333'; ctx.fillRect(e.x - 20, e.y - (e.isBoss ? 45 : 30), 40, 5);
            ctx.fillStyle = '#3b82f6'; ctx.fillRect(e.x - 20, e.y - (e.isBoss ? 45 : 30), 40 * (e.hp / e.maxHp), 5);
          }
        });

        // Draw Lasers
        snap.lasers.forEach(l => {
          ctx.save();
          ctx.translate(l.x, l.y);
          ctx.rotate(l.heading);
          if (l.state === 'telegraph') {
            ctx.fillStyle = `rgba(59, 130, 246, ${0.1 + l.progress * 0.4})`;
            ctx.fillRect(0, -l.width / 2, l.length, l.width);

            // Center core line
            ctx.strokeStyle = `rgba(59, 130, 246, ${l.progress})`;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(l.length, 0); ctx.stroke();
          } else if (l.state === 'firing') {
            ctx.fillStyle = `rgba(59, 130, 246, ${l.progress})`;
            ctx.fillRect(0, -l.width / 2 - (Math.random() * 4), l.length, l.width + (Math.random() * 8));

            ctx.fillStyle = `rgba(255, 255, 255, ${l.progress})`;
            ctx.fillRect(0, -l.width / 4 - (Math.random() * 2), l.length, l.width / 2 + (Math.random() * 4));
          }
          ctx.restore();
        });

        // 5. Draw Missiles
        snap.missiles.forEach(m => {
          ctx.save();
          ctx.translate(m.x, m.y);
          ctx.rotate(m.heading);
          // Player is red, enemy is blue
          ctx.fillStyle = m.isPlayerMissile ? '#ef4444' : '#3b82f6';
          ctx.fillRect(0, -2, 12, 4);
          ctx.fillStyle = m.isPlayerMissile ? '#f97316' : '#60a5fa'; // flame
          ctx.beginPath(); ctx.arc(-2, 0, 6, 0, Math.PI * 2); ctx.fill(); // flame
          ctx.restore();

          // Add missile trail
          particlesRef.current.push({
            x: m.x - Math.cos(m.heading) * 10,
            y: m.y - Math.sin(m.heading) * 10,
            vx: (Math.random() - 0.5) * 20,
            vy: (Math.random() - 0.5) * 20,
            life: 1.0,
            maxLife: 0.2 + Math.random() * 0.2,
            color: m.isPlayerMissile ? 'rgba(239, 68, 68, 0.5)' : 'rgba(59, 130, 246, 0.5)',
            size: Math.random() * 3 + 1
          });
        });

        // 6. Draw Player
        if (snap.player) {
          drawJet(snap.player.x, snap.player.y, snap.player.heading, '#ef4444', 1.2); // Player is Red

          if (snap.player.isDashing) {
            // Add dash trail
            particlesRef.current.push({
              x: snap.player.x - Math.cos(snap.player.heading) * 20,
              y: snap.player.y - Math.sin(snap.player.heading) * 20,
              vx: -Math.cos(snap.player.heading) * 100 + (Math.random() - 0.5) * 50,
              vy: -Math.sin(snap.player.heading) * 100 + (Math.random() - 0.5) * 50,
              life: 1.0,
              maxLife: 0.3 + Math.random() * 0.2,
              color: '#ef4444', // Red dash trail
              size: Math.random() * 6 + 3
            });
          }
        }

        // 7. Update and Draw Particles
        for (let i = particlesRef.current.length - 1; i >= 0; i--) {
          const p = particlesRef.current[i];
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.life -= dt;
          if (p.life <= 0) {
            particlesRef.current.splice(i, 1);
          } else {
            ctx.globalAlpha = p.life / p.maxLife;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * (p.life / p.maxLife), 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1.0;
          }
        }

        ctx.restore(); // restore camera translate

        // Update particles (if player is dead, we want them still drawing!)
        // Wait, current particle coords are assuming world coordinate space.
        // If player is dead, we don't have a camera focus! Let's handle it by tracking camera offset independently, but for now we just let them disappear.

        // Draw Vignette if cinematic
        if (snap.cinematicFocus) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
          ctx.fillRect(-width, -height, width * 3, height * 3);

          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0); // reset transform for UI overlay
          // Dramatic text
          const textAlpha = 1.0 - Math.abs(snap.cinematicFocus.timer - (snap.cinematicFocus.maxTimer / 2)) / (snap.cinematicFocus.maxTimer / 2);
          ctx.fillStyle = `rgba(239, 68, 68, ${textAlpha})`;
          ctx.font = 'bold 80px "JetBrains Mono"';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = '#dc2626';
          ctx.shadowBlur = 30;
          ctx.fillText("目标已被摧毁", width / 2, height / 2 + 200);
          ctx.shadowBlur = 0;
          ctx.shadowColor = 'transparent';
          ctx.restore();
        }

        ctx.restore(); // restore global shake translate (outside if snap.player!)

        // 8. Boss Direction Indicator
        if (snap.bossIndicatorTime > 0) {
          const boss = snap.enemies.find(e => e.isBoss);
          if (boss) {
            const cx = width / 2;
            const cy = height / 2;
            // Calculate boss position in screen space
            const screenBossX = boss.x + cx - camX;
            const screenBossY = boss.y + cy - camY;

            // if boss is outside screen bounds approx (give some margin)
            if (screenBossX < 0 || screenBossX > width || screenBossY < 0 || screenBossY > height) {
              const angle = Math.atan2(screenBossY - cy, screenBossX - cx);
              const padding = 60;

              const rx = width / 2 - padding;
              const ry = height / 2 - padding;

              let tx = Math.cos(angle);
              let ty = Math.sin(angle);

              // Handle division by zero nicely
              let scale = Math.min(
                Math.abs(tx) > 0.001 ? Math.abs(rx / tx) : Infinity,
                Math.abs(ty) > 0.001 ? Math.abs(ry / ty) : Infinity
              );

              const ix = cx + tx * scale;
              const iy = cy + ty * scale;

              const blink = Math.floor(performance.now() / 200) % 2 === 0;
              if (blink) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0); // screen space
                ctx.translate(ix, iy);
                ctx.rotate(angle);

                ctx.fillStyle = '#ef4444';
                ctx.shadowColor = '#ef4444';
                ctx.shadowBlur = 15;

                ctx.beginPath();
                ctx.moveTo(15, 0);
                ctx.lineTo(-15, 10);
                ctx.lineTo(-15, -10);
                ctx.closePath();
                ctx.fill();

                ctx.font = 'bold 16px "JetBrains Mono"';
                ctx.fillStyle = '#ef4444';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText("巨型战机", -25, 0);
                ctx.restore();
              }
            }
          }
        }
      }
      animationId = requestAnimationFrame(render);
    };
    animationId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationId);
      engine.stop();
    };
  }, []);

  const snapshot = viewSnapshot?.game ?? null;
  const network = viewSnapshot?.network ?? null;
  const shouldShowDisconnectWarning = Boolean(
    network
    && (network.connectionState === 'disconnected'
      || network.connectionState === 'error'
      || network.syncState === 'stale'
      || network.syncState === 'disconnected'),
  );

  return (
    <div className="relative w-full h-full bg-slate-900 overflow-hidden font-mono text-white select-none">
      <canvas
        ref={canvasRef}
        width={window.innerWidth}
        height={window.innerHeight}
        className="block"
      />

      {fatalError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-8">
          <div className="max-w-2xl border border-red-500/40 bg-slate-900/90 p-8 text-left shadow-2xl">
            <div className="text-2xl font-bold tracking-widest text-red-400">联机初始化失败</div>
            <div className="mt-4 text-sm leading-7 text-slate-300">{fatalError}</div>
            <div className="mt-4 text-xs leading-6 text-slate-500">
              启动前请配置 `VITE_NETWORK_BATTLE_WS_URL`，并通过 URL 查询参数显式提供 `roomId`、`playerName`、`faction`。
            </div>
          </div>
        </div>
      )}

      {/* --- View Layer (HUD) Component overlayed strictly reading from Snapshot --- */}
      {snapshot && (
        <div className="absolute inset-0 pointer-events-none p-6">
          {/* Top Left: Diagnostics & Status */}
          <div className="absolute top-6 left-6 space-y-4">
            <div className="text-xl font-bold tracking-widest text-emerald-400 drop-shadow-md">
              空战 <span className="text-slate-400 text-sm">模拟系统</span>
            </div>

            {snapshot.bossSpawning && (
              <div className="fixed top-8 left-1/2 -translate-x-1/2 text-center pointer-events-none z-50 flex items-center gap-4 bg-slate-900/90 border border-red-500/50 px-6 py-2 rounded-full shadow-[0_0_15px_rgba(239,68,68,0.5)]">
                <div className="w-3 h-3 rounded-full bg-red-500 animate-ping"></div>
                <div className="text-lg font-bold tracking-widest text-red-400">
                  警告：巨型战机接近
                </div>
                <div className="w-3 h-3 rounded-full bg-red-500 animate-ping"></div>
              </div>
            )}

            {(() => {
              const boss = snapshot.enemies.find(e => e.isBoss);
              if (boss && !snapshot.bossSpawning) {
                return (
                  <div className="fixed top-8 left-1/2 -translate-x-1/2 w-[600px] pointer-events-none z-50 flex flex-col items-center gap-2">
                    <div className="text-xl font-bold tracking-[0.5em] text-red-500 drop-shadow-md">
                      未知目标
                    </div>
                    <div className="w-full h-4 bg-slate-900/80 border border-red-500/30 rounded-full overflow-hidden shadow-[0_0_20px_rgba(239,68,68,0.3)]">
                      <div
                        className="h-full bg-gradient-to-r from-red-600 to-red-400 transition-all duration-300"
                        style={{ width: `${(boss.hp / boss.maxHp) * 100}%` }}
                      ></div>
                    </div>
                    <div className="text-xs text-red-400/80 tracking-widest">
                      战术打击巨兽
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            <div className="bg-slate-800/80 p-4 border-l-4 border-emerald-500 rounded backdrop-blur-sm flex flex-col gap-2">
              <div className="flex justify-between w-48">
                <span className="text-slate-400">帧率 (FPS)</span>
                <span className={`${snapshot.fps < 30 ? 'text-red-400' : 'text-emerald-400'} font-bold`}>{snapshot.fps}</span>
              </div>
              <div className="flex justify-between w-48">
                <span className="text-slate-400">敌方战机</span>
                <span className="text-blue-400 font-bold">{snapshot.enemies.length}</span>
              </div>
              <div className="flex justify-between w-48 text-emerald-300 font-bold mt-2 pt-2 border-t border-emerald-500/30">
                <span>作战得分</span>
                <span>{snapshot.score}</span>
              </div>
            </div>

            {network && (
              <div className="bg-slate-800/80 p-4 border-l-4 border-cyan-500 rounded backdrop-blur-sm flex flex-col gap-2 min-w-72">
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">房间</span>
                  <span className="font-bold text-cyan-300">{network.roomId}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">连接状态</span>
                  <span className={`font-bold ${getStatusColor(network.connectionState)}`}>{getConnectionLabel(network)}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">同步状态</span>
                  <span className={`font-bold ${getStatusColor(network.syncState)}`}>{getSyncLabel(network)}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">房间阶段</span>
                  <span className="text-slate-200">{network.roomPhase ?? '等待服务端'}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">往返延迟</span>
                  <span className="text-slate-200">{network.pingMs === null ? '--' : `${network.pingMs} ms`}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">服务端 Tick</span>
                  <span className="text-slate-200">{network.lastServerTick ?? '--'}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-400">已确认输入</span>
                  <span className="text-slate-200">{network.lastProcessedInputSequence}</span>
                </div>
                <div className="pt-2 mt-2 border-t border-cyan-500/20">
                  <div className="text-slate-400 mb-2">对端玩家</div>
                  {network.remotePlayers.length > 0 ? (
                    <div className="space-y-1">
                      {network.remotePlayers.map((player) => (
                        <div key={player.playerId} className="flex justify-between gap-6 text-xs">
                          <span className="text-slate-200">{player.playerName}</span>
                          <span className={player.ready ? 'text-emerald-400' : 'text-amber-400'}>
                            {player.faction} / {player.ready ? '已准备' : '未准备'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">暂无对端玩家接入</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Top Right: Player Telemetry */}
          {snapshot.player && (
            <div className="absolute top-6 right-6 space-y-4 text-right">
              <div className="text-sm tracking-widest text-red-400">歼-20 威龙</div>
              <div className="bg-slate-800/80 p-4 border-r-4 border-red-500 rounded backdrop-blur-sm w-64 flex flex-col gap-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>机体生命值</span>
                    <span>{snapshot.player.hp.toFixed(0)}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-700">
                    <div className="h-full bg-red-500 transition-all duration-300" style={{ width: `${(snapshot.player.hp / snapshot.player.maxHp) * 100}%` }}></div>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>飞行空速</span>
                    <span>{snapshot.player.speed.toFixed(0)}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-700">
                    <div className="h-full bg-emerald-400 transition-all" style={{ width: `${(snapshot.player.speed / 500) * 100}%` }}></div>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>喷气冲刺冷却</span>
                    <span>{snapshot.player.dashCooldown > 0 ? `${snapshot.player.dashCooldown.toFixed(1)}s` : '就绪'}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-700">
                    <div className={`h-full transition-all ${snapshot.player.dashCooldown > 0 ? 'bg-orange-500' : 'bg-emerald-400'}`} style={{ width: `${snapshot.player.dashCooldown > 0 ? (1 - snapshot.player.dashCooldown / 5.0) * 100 : 100}%` }}></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Bottom Center: Game State Warnings */}
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 text-center pointer-events-auto">
            {snapshot.status !== 'playing' && (
              <div className={`flex flex-col items-center gap-4 py-8 px-16 border-4 bg-slate-900/90 backdrop-blur-md text-red-500 border-red-500`}>
                <div className="text-6xl font-black tracking-widest">机毁人亡</div>
                <div className="text-2xl font-bold text-emerald-400">最终得分: {snapshot.score}</div>
                <button
                  onClick={() => onGameOver(snapshot.score)}
                  className="mt-4 px-8 py-3 bg-red-600 hover:bg-red-500 text-white font-bold tracking-widest rounded transition-all"
                >
                  返回主界面
                </button>
              </div>
            )}

            {snapshot.status === 'playing' && snapshot.player && snapshot.enemies.some(e => Math.hypot(e.x - snapshot.player!.x, e.y - snapshot.player!.y) < 800) && (
              <div className="flex items-center gap-2 text-red-400 font-bold animate-pulse p-2 px-8 rounded-full bg-red-500/10 border border-red-500/50">
                <AlertTriangle size={20} />
                <span>敌方雷达锁定警告</span>
              </div>
            )}

            {shouldShowDisconnectWarning && network && (
              <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-amber-400/50 bg-slate-900/90 px-8 py-4 text-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.15)]">
                <div className="font-bold tracking-widest">联机告警</div>
                <div className="text-sm">
                  {network.disconnectReason ?? network.errorMessage ?? '当前未能保持与权威服务器的稳定同步'}
                </div>
              </div>
            )}
          </div>

          {/* Controls Hint */}
          <div className="absolute bottom-6 left-6 text-xs text-slate-500 flex flex-col gap-1">
            <span>[W/A/S/D] 移动控制</span>
            <span>[鼠标左键] 连发空空导弹</span>
            <span>[鼠标右键] 喷气冲刺 (冷却5s,击杀重置)</span>
          </div>

          <div className="absolute bottom-6 right-6 text-emerald-500/30 opacity-50 flex items-center gap-2">
            <Radar className="animate-spin duration-3000" size={64} />
          </div>
        </div>
      )}
    </div>
  );
}
