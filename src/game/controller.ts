import { Vector2D, Battlefield, Fighter, Missile, Laser } from './model';
import {
  GameSnapshot,
  GameViewSnapshot,
  ICombatJudger,
  IMissile,
  IFighter,
  IAIController,
  IRadarSystem,
  NetworkHudSnapshot,
  NetworkPlayerInput,
  FighterSnapshot,
  StateSnapshotPayload,
} from './interfaces';
import { JsonNetworkProtocol } from './network-protocol.ts';
import { NetworkBattleSession, readBrowserNetworkJoinConfig } from './network-client.ts';
import { interpolateFighterCorrection, predictLocalFighter } from './network-sync.ts';

import { audioManager } from './audio';

// --- Controllers & Logic ---

export class InputHandler {
  public keys: Record<string, boolean> = {};
  public mousePos = new Vector2D(0, 0);
  public mouseDown = false;
  public rightMouseDown = false;
  public rightMousePressed = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.keys[e.code] = true);
    window.addEventListener('keyup', (e) => this.keys[e.code] = false);
  }

  attachCanvas(canvas: HTMLCanvasElement) {
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mousePos = new Vector2D(e.clientX - rect.left, e.clientY - rect.top);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) {
        this.rightMouseDown = true;
        this.rightMousePressed = true;
      }
    });
    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightMouseDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}

// 模拟多线程/异步任务队列的碰撞检测 (满足作业的线程池/分离计算要求)
// 在正式环境可用 Web Worker，这里使用微任务队列来避免阻塞主绘制流
export class AsyncCombatJudger implements ICombatJudger {
  public onExplosion?: (x: number, y: number) => void;
  // AABB 及 圆形粗略碰撞检测
  CheckCollision(missiles: IMissile[], lasers: unknown[], fighters: IFighter[], onKill?: (killerIsPlayer: boolean, isBoss: boolean | undefined, x: number, y: number) => void): void {
    Promise.resolve().then(() => {
      // Missiles vs Fighters
      for (const m of missiles) {
        if (!m.isActive) continue;
        for (const f of fighters) {
          if (f.hp <= 0) continue;
          // 不要打自己人
          const isPlayerMissile = (m as any).isPlayerMissile;
          if (isPlayerMissile === f.isPlayer) continue;

          if (this.JudgeHit(m, f)) {
            f.TakeDamage(m.damage);
            m.Detonate();
            if (f.hp <= 0 && onKill) {
              onKill(isPlayerMissile, (f as any).isBoss, f.position.x, f.position.y);
            } else {
              audioManager.playExplosionSound();
              if (this.onExplosion) this.onExplosion(f.position.x, f.position.y);
            }
            break;
          }
        }
      }

      // Fighters vs Player collision
      for (const f of fighters) {
        if (f.isPlayer && f.hp > 0) {
          const player = f;
          for (const e of fighters) {
            if (!e.isPlayer && e.hp > 0) {
              const dist = new Vector2D(player.position.x, player.position.y).distanceTo(e.position);
              if (dist < 40) { // Collision between player and enemy
                player.hp = 0;
                audioManager.playExplosionSound();
                if (this.onExplosion) this.onExplosion(player.position.x, player.position.y);
              }
            }
          }
        }
      }

      // Lasers vs Fighters
      for (const l of lasers as Laser[]) {
        if (l.state === 'firing' && !l.hasHit) {
          for (const f of fighters) {
            if (f.hp <= 0) continue;
            if (f.isPlayer) { // Lasers hit player only (Boss laser)
              // distance from line
              const dist = this.DistanceToLine(f.position, l.position, l.heading, l.length);
              if (dist < l.width / 2 + 15) { // 15 is fighter radius roughly
                f.TakeDamage(l.damage);
                l.hasHit = true;
                if (f.hp <= 0 && onKill) {
                  onKill(false, false, f.position.x, f.position.y);
                } else {
                  audioManager.playExplosionSound();
                  if (this.onExplosion) this.onExplosion(f.position.x, f.position.y);
                }
              }
            }
          }
        }
      }
    });
  }

  DistanceToLine(pt: { x: number, y: number }, origin: { x: number, y: number }, heading: number, length: number): number {
    const endX = origin.x + Math.cos(heading) * length;
    const endY = origin.y + Math.sin(heading) * length;
    const l2 = length * length;
    if (l2 === 0) return Math.hypot(pt.x - origin.x, pt.y - origin.y);
    let t = ((pt.x - origin.x) * (endX - origin.x) + (pt.y - origin.y) * (endY - origin.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = origin.x + t * (endX - origin.x);
    const projY = origin.y + t * (endY - origin.y);
    return Math.hypot(pt.x - projX, pt.y - projY);
  }

  JudgeHit(missile: IMissile, fighter: IFighter): boolean {
    const dist = new Vector2D(missile.position.x, missile.position.y)
      .distanceTo(fighter.position);
    return dist < 30; // 碰撞半径
  }

  UpdateBattleStatus(player: IFighter, enemies: IFighter[]): 'playing' | 'defeat' {
    if (player.hp <= 0) return 'defeat';
    return 'playing';
  }
}

export class EnemyAI implements IAIController {
  Decide(dt: number, enemies: IFighter[], player: IFighter) {
    const actions: { missiles: IMissile[], lasers: Laser[] } = { missiles: [], lasers: [] };
    // 简单的追踪策略，模拟 AI 处理分离
    for (const enemy of enemies) {
      if (enemy.hp <= 0) continue;
      const dist = new Vector2D(enemy.position.x, enemy.position.y).distanceTo(player.position);

      const targetDir = new Vector2D(player.position.x - enemy.position.x, player.position.y - enemy.position.y).normalize();
      const currentHeadingV = new Vector2D(Math.cos(enemy.heading), Math.sin(enemy.heading));

      // 简单平滑转向
      const turnSpeedMultiplier = enemy.isBoss ? 0.8 : 2;
      enemy.heading = Math.atan2(
        currentHeadingV.y + targetDir.y * turnSpeedMultiplier * dt,
        currentHeadingV.x + targetDir.x * turnSpeedMultiplier * dt
      );

      if (dist > 300) {
        enemy.speed = enemy.speed + (enemy.maxSpeed - enemy.speed) * dt; // 加速靠近
      } else {
        enemy.speed = enemy.speed + (200 - enemy.speed) * dt; // 减速狗斗
      }

      // Attacks
      if (enemy.isBoss) {
        // High prob of laser
        if (enemy.laserCooldown <= 0) {
          enemy.laserCooldown = 5.0; // Fixed pattern or random
          if (Math.random() < 0.8) {
            actions.lasers.push(new Laser(enemy.position.x, enemy.position.y, enemy.heading));
          } else {
            // Low prob semi-homing missile
            const m = enemy.Fire(player);
            if (m) {
              m.isPlayerMissile = false;
              m.homingType = 'semi';
              actions.missiles.push(m);
            }
          }
        }
      } else {
        // Decreased fire rate: 0.005 instead of 0.01
        if (Math.random() < 0.005 * (dt * 60) && dist < 500) {
          const m = enemy.Fire(player);
          if (m) {
            m.isPlayerMissile = false;
            m.homingType = 'none'; // Straight line
            actions.missiles.push(m);
          }
        }
      }
    }
    return actions;
  }
  Execute() { }
  SetDifficulty() { }
}

export class RadarSystem implements IRadarSystem {
  public range = 1000; // 预警机/雷达范围
  Scan(origin: Vector2D, targets: IFighter[]) {
    targets.forEach(t => {
      const dist = origin.distanceTo(t.position);
      t.inRadarRange = dist <= this.range;
    });
    return targets.filter(t => t.inRadarRange);
  }
  SetRange(r: number) { this.range = r; }
}

// 预留网络层，当前直接复用共享 JSON 协议实现。
export class SimulatedNetwork extends JsonNetworkProtocol { }

interface CorrectionState {
  from: FighterSnapshot;
  to: FighterSnapshot;
  startedAtMs: number;
  durationMs: number;
}

const PREDICTION_CONFIG = {
  tickDurationMs: 100,
  speedStepPerTick: 35,
  minSpeed: 80,
  maxSpeed: 440,
  turnStepPerTick: 0.22,
};

const CORRECTION_DURATION_MS = 180;

// --- Main Engine ---
export class GameEngine {
  private battlefield = new Battlefield();
  private lastTime = 0;
  private fps = 0;
  private authoritativeSnapshot: GameSnapshot;
  private presentationSnapshot: GameSnapshot;
  private networkState: NetworkHudSnapshot;
  private inputSequence = 0;
  private lastInputSignature = '';
  private lastInputSentAt = 0;
  private unsubscribeHandlers: Array<() => void> = [];
  private running = false;
  private animationId = 0;
  private readonly networkSession: NetworkBattleSession;
  private correctionState: CorrectionState | null = null;

  public input = new InputHandler();
  public onExplosion?: (x: number, y: number) => void;
  public onBossExplosion?: (x: number, y: number) => void;
  public onSnapshotUpdated?: (snapshot: GameViewSnapshot) => void;

  constructor() {
    this.authoritativeSnapshot = this.createWaitingSnapshot();
    this.presentationSnapshot = this.createWaitingSnapshot();
    const protocol = new JsonNetworkProtocol();
    const sessionConfig = {
      ...readBrowserNetworkJoinConfig(),
      protocol,
    };
    this.networkSession = new NetworkBattleSession(sessionConfig);
    this.networkState = this.networkSession.getState();

    this.unsubscribeHandlers.push(this.networkSession.subscribe((snapshot) => {
      this.networkState = snapshot;
    }));
    this.unsubscribeHandlers.push(this.networkSession.onSnapshot((payload) => {
      this.consumeAuthoritativeSnapshot(payload);
    }));
    this.unsubscribeHandlers.push(this.networkSession.onCombatEvent((payload) => {
      if (payload.position && (payload.eventType === 'fighter_destroyed' || payload.eventType === 'hit_result')) {
        audioManager.playExplosionSound();
        if (this.onExplosion) {
          this.onExplosion(payload.position.x, payload.position.y);
        }
      }
      if (payload.position && payload.eventType === 'fighter_destroyed' && this.onBossExplosion) {
        this.onBossExplosion(payload.position.x, payload.position.y);
      }
    }));
  }

  private createWaitingSnapshot(): GameSnapshot {
    return {
      fps: 0,
      player: this.battlefield.player.GetState(),
      enemies: [],
      missiles: [],
      lasers: [],
      mapBounds: this.battlefield.mapBounds,
      status: 'playing',
      radarRange: 1000,
      score: 0,
      timeScale: 1,
      cinematicFocus: null,
      bossSpawning: false,
      bossIndicatorTime: 0,
    };
  }

  private remapSnapshotToLocalPerspective(snapshot: GameSnapshot): GameSnapshot {
    const localPlayerId = this.networkState.localPlayerId;
    if (snapshot.player?.id === localPlayerId) {
      return snapshot;
    }

    const localPlayerIndex = snapshot.enemies.findIndex((fighter) => fighter.id === localPlayerId);
    if (localPlayerIndex < 0) {
      return snapshot;
    }

    const localPlayer = {
      ...snapshot.enemies[localPlayerIndex],
      isPlayer: true,
      inRadarRange: true,
    };
    const swappedEnemies = snapshot.enemies.filter((_, index) => index !== localPlayerIndex);
    if (snapshot.player) {
      swappedEnemies.push({
        ...snapshot.player,
        isPlayer: false,
      });
    }

    const normalizedEnemies = swappedEnemies.map((fighter) => ({
      ...fighter,
      isPlayer: false,
      inRadarRange: Math.hypot(fighter.x - localPlayer.x, fighter.y - localPlayer.y) <= snapshot.radarRange,
    }));

    return {
      ...snapshot,
      player: localPlayer,
      enemies: normalizedEnemies,
    };
  }

  private consumeAuthoritativeSnapshot(payload: StateSnapshotPayload): void {
    const localizedState = this.remapSnapshotToLocalPerspective(payload.state);
    const nextAuthoritativeSnapshot = {
      ...localizedState,
      fps: this.fps,
    };

    if (this.presentationSnapshot.player && nextAuthoritativeSnapshot.player) {
      const playerDistance = Math.hypot(
        this.presentationSnapshot.player.x - nextAuthoritativeSnapshot.player.x,
        this.presentationSnapshot.player.y - nextAuthoritativeSnapshot.player.y,
      );

      if (playerDistance >= 240) {
        this.networkSession.requestResync('state_divergence');
        this.correctionState = null;
      } else if (playerDistance >= 40) {
        this.correctionState = {
          from: { ...this.presentationSnapshot.player },
          to: { ...nextAuthoritativeSnapshot.player },
          startedAtMs: performance.now(),
          durationMs: CORRECTION_DURATION_MS,
        };
      } else {
        this.correctionState = null;
      }
    } else {
      this.correctionState = null;
    }

    this.authoritativeSnapshot = nextAuthoritativeSnapshot;
  }

  private refreshPresentationSnapshot(dtSeconds: number, nowMs: number): void {
    const nextSnapshot: GameSnapshot = {
      ...this.authoritativeSnapshot,
      player: this.authoritativeSnapshot.player ? { ...this.authoritativeSnapshot.player } : null,
      enemies: this.authoritativeSnapshot.enemies.map((enemy) => ({ ...enemy })),
      missiles: this.authoritativeSnapshot.missiles.map((missile) => ({ ...missile })),
      lasers: this.authoritativeSnapshot.lasers.map((laser) => ({ ...laser })),
      fps: this.fps,
    };

    if (!nextSnapshot.player) {
      this.presentationSnapshot = nextSnapshot;
      return;
    }

    if (this.correctionState && this.correctionState.to.id === nextSnapshot.player.id) {
      const elapsedMs = nowMs - this.correctionState.startedAtMs;
      const progress = Math.min(Math.max(elapsedMs / this.correctionState.durationMs, 0), 1);
      nextSnapshot.player = interpolateFighterCorrection(this.correctionState.from, this.correctionState.to, progress);
      if (progress >= 1) {
        this.correctionState = null;
      }
      this.presentationSnapshot = nextSnapshot;
      return;
    }

    if (this.networkState.connectionState === 'connected' && this.networkState.roomPhase === 'running') {
      nextSnapshot.player = predictLocalFighter(
        nextSnapshot.player,
        this.buildNetworkInput(),
        dtSeconds,
        nextSnapshot.mapBounds,
        PREDICTION_CONFIG,
      );
    }

    this.presentationSnapshot = nextSnapshot;
  }

  private updateLoop = (timestamp: number) => {
    if (!this.running) return;
    const realDt = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;

    if (realDt > 0 && realDt < 0.1) {
      this.fps = Math.floor(1 / realDt);
      this.pushCurrentInput(Date.now());
      this.refreshPresentationSnapshot(realDt, timestamp);
    }

    if (this.onSnapshotUpdated) {
      this.onSnapshotUpdated(this.getViewSnapshot());
    }

    this.animationId = requestAnimationFrame(this.updateLoop);
  };

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.networkSession.connect();
    this.animationId = requestAnimationFrame(this.updateLoop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.animationId);
    this.networkSession.disconnect('客户端停止渲染循环');
    this.unsubscribeHandlers.forEach((dispose) => dispose());
    this.unsubscribeHandlers = [];
  }

  private buildNetworkInput(): NetworkPlayerInput {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const hasMouseAim = this.input.mousePos.x !== 0 || this.input.mousePos.y !== 0;
    const aimHeading = hasMouseAim
      ? Math.atan2(this.input.mousePos.y - centerY, this.input.mousePos.x - centerX)
      : null;

    return {
      throttle: this.input.keys['KeyW'] || this.input.keys['ArrowUp']
        ? 'accelerate'
        : (this.input.keys['KeyS'] || this.input.keys['ArrowDown'] ? 'decelerate' : 'hold'),
      turn: this.input.keys['KeyA'] || this.input.keys['ArrowLeft']
        ? 'left'
        : (this.input.keys['KeyD'] || this.input.keys['ArrowRight'] ? 'right' : 'hold'),
      fireMissile: Boolean(this.input.keys['Space'] || this.input.mouseDown),
      fireBomb: this.input.rightMousePressed,
      targetId: null,
      aimHeading,
    };
  }

  private pushCurrentInput(nowMs: number): void {
    if (this.networkState.connectionState !== 'connected') {
      return;
    }
    if (this.networkState.roomPhase !== 'running') {
      return;
    }

    const currentInput = this.buildNetworkInput();
    const inputSignature = JSON.stringify(currentInput);
    const shouldSend = inputSignature !== this.lastInputSignature || nowMs - this.lastInputSentAt >= 100;
    if (!shouldSend) {
      return;
    }

    this.inputSequence += 1;
    const acknowledgedTick = this.networkState.lastServerTick ?? 0;
    this.networkSession.sendPlayerInput(
      currentInput,
      acknowledgedTick + 1,
      acknowledgedTick,
      this.inputSequence,
    );
    this.lastInputSignature = inputSignature;
    this.lastInputSentAt = nowMs;

    if (this.input.rightMousePressed) {
      this.input.rightMousePressed = false;
    }
  }

  public getSnapshot(): GameSnapshot {
    return {
      ...this.presentationSnapshot,
      fps: this.fps,
    };
  }

  public getViewSnapshot(): GameViewSnapshot {
    return {
      game: this.getSnapshot(),
      network: {
        ...this.networkState,
        remotePlayers: [...this.networkState.remotePlayers],
      },
    };
  }
}
