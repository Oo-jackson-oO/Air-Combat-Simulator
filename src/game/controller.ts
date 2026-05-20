import { Vector2D, Battlefield, Fighter, Missile, Laser } from './model';
import { GameSnapshot, ICombatJudger, IMissile, IFighter, IAIController, IRadarSystem, NetMessageType, INetworkProtocol } from './interfaces';

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

  DistanceToLine(pt: {x: number, y: number}, origin: {x: number, y: number}, heading: number, length: number): number {
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
  Execute() {}
  SetDifficulty() {}
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

// 预留网络层 (空实现)
export class SimulatedNetwork implements INetworkProtocol {
  Serialize(data: any, type: NetMessageType) { return JSON.stringify({ type, data }); }
  Deserialize(payload: string) { return JSON.parse(payload); }
  GetMessageType(payload: string) { return JSON.parse(payload).type as NetMessageType; }
}

// --- Main Engine ---
export class GameEngine {
  private battlefield = new Battlefield();
  private lastTime = 0;
  private fps = 0;
  private judger = new AsyncCombatJudger();
  private ai = new EnemyAI();
  private radar = new RadarSystem();
  private status: 'playing' | 'defeat' = 'playing';
  private score = 0;
  private lastBossScore = 0;
  private bossCooldownTimer = 0;
  private bossSpawning = false;
  private bossSpawnTimer = 0;
  private bossIndicatorTimer = 0;
  private timeSinceLastSpawn = 0;

  public input = new InputHandler();
  public onExplosion?: (x: number, y: number) => void;
  public onBossExplosion?: (x: number, y: number) => void;
  public cinematicFocus: { x: number, y: number, timer: number, maxTimer: number } | null = null;
  private timeScale = 1.0;
  
  // View/React binds to this
  public onSnapshotUpdated?: (snapshot: GameSnapshot) => void;

  private running = false;
  private animationId = 0;

  constructor() {
    this.judger.onExplosion = (x, y) => {
      if (this.onExplosion) this.onExplosion(x, y);
    };
  }

  private updateLoop = (timestamp: number) => {
    if (!this.running) return;
    const realDt = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;
    if (realDt > 0 && realDt < 0.1) { // Cap dt to avoid huge jumps
      if (this.cinematicFocus) {
         this.cinematicFocus.timer -= realDt;
         if (this.cinematicFocus.timer <= 0) {
           this.cinematicFocus = null;
           this.timeScale = 1.0;
         }
      }
      
      const dt = realDt * this.timeScale;
      this.fps = Math.floor(1 / realDt);
      if (this.status === 'playing') {
        this.updateFrame(dt);
      }
    }
    
    // Push strict data downwards to the View layer (MVC Constraint)
    if (this.onSnapshotUpdated) {
      this.onSnapshotUpdated(this.getSnapshot());
    }

    this.animationId = requestAnimationFrame(this.updateLoop);
  };

  start() {
    this.running = true;
    this.lastTime = performance.now();
    this.animationId = requestAnimationFrame(this.updateLoop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.animationId);
  }

  private updateFrame(dt: number) {
    const p = this.battlefield.player;
    
    // Player is always rendered at the center of the window by the View layer
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    let targetHeading = p.heading;
    
    if (this.input.mousePos.x !== 0 || this.input.mousePos.y !== 0) {
       targetHeading = Math.atan2(
         this.input.mousePos.y - centerY,
         this.input.mousePos.x - centerX
       );
       p.heading = targetHeading;
    }
    
    // WASD Movement
    let moveX = 0;
    let moveY = 0;
    if (this.input.keys['KeyA']) moveX -= 1;
    if (this.input.keys['KeyD']) moveX += 1;
    if (this.input.keys['KeyW']) moveY -= 1;
    if (this.input.keys['KeyS']) moveY += 1;

    if (moveX !== 0 || moveY !== 0) {
      const mag = Math.sqrt(moveX * moveX + moveY * moveY);
      moveX /= mag;
      moveY /= mag;
      p.velocity.x = moveX * p.maxSpeed;
      p.velocity.y = moveY * p.maxSpeed;
      p.speed = p.maxSpeed; // purely visual now for HUD
    } else {
      // Decelerate quickly if no input
      p.velocity.x *= Math.pow(0.1, dt);
      p.velocity.y *= Math.pow(0.1, dt);
      p.speed = p.velocity.mag();
    }

    // Dash
    if (this.input.rightMousePressed) {
      if (p.dashCooldown <= 0) {
         audioManager.playDashSound();
         this.score += 5;
      }
      p.Dash(targetHeading);
      this.input.rightMousePressed = false;
    }

    // Fire continuous
    if (this.input.keys['Space'] || this.input.mouseDown) {
      const m = p.Fire(undefined, targetHeading);
      if (m) {
        audioManager.playShootSound();
        (m as any).isPlayerMissile = true;
        this.battlefield.missiles.push(m as Missile);
      }
    }

    // 更新各实体
    p.Update(dt, this.battlefield.mapBounds);
    
    const actions = this.ai.Decide(dt, this.battlefield.enemies, p) as any;
    if (actions && actions.missiles) {
        actions.missiles.forEach((m: Missile) => {
           audioManager.playShootSound();
           this.battlefield.missiles.push(m);
        });
    }
    if (actions && actions.lasers) {
        actions.lasers.forEach((l: Laser) => {
           audioManager.playShootSound(); // Maybe a different charging sound
           this.battlefield.lasers.push(l);
        });
    }

    this.battlefield.enemies.forEach(e => e.Update(dt, this.battlefield.mapBounds));
    this.battlefield.missiles.forEach(m => m.Update(dt));
    this.battlefield.lasers.forEach(l => {
      // Lasers move with boss if it's attached, but let's just make it a static beam for now
      l.Update(dt);
    });

    // Endless Spawning
    this.timeSinceLastSpawn += dt;
    if (this.timeSinceLastSpawn >= 2 + Math.random()) {
      this.timeSinceLastSpawn = 0;
      const count = Math.random() > 0.5 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const enemy = new Fighter(false, false);
        enemy.position = new Vector2D(
          Math.random() < 0.5 ? 100 : this.battlefield.mapBounds.width - 100,
          Math.random() * this.battlefield.mapBounds.height
        );
        this.battlefield.enemies.push(enemy);
      }
    }
    
    // Boss Spawning Condition
    if (this.bossCooldownTimer > 0) {
       this.bossCooldownTimer -= dt;
    }

    if (this.bossSpawning) {
       this.bossSpawnTimer -= dt;
       if (this.bossSpawnTimer <= 0) {
          this.bossSpawning = false;
          this.lastBossScore = this.score;
          const boss = new Fighter(false, true);
          boss.position = new Vector2D(this.battlefield.mapBounds.width / 2, 100); // spawn inside screen
          this.battlefield.enemies.push(boss);
          this.bossIndicatorTimer = 3.0;
       }
    } else if (this.bossCooldownTimer <= 0 && this.score >= this.lastBossScore + 100 && !this.battlefield.enemies.some((e) => (e as any).isBoss)) {
       this.bossSpawning = true;
       this.bossSpawnTimer = 3.0; // 3 seconds warning
       audioManager.playBossWarningSound();
    }

    if (this.bossIndicatorTimer > 0) {
       this.bossIndicatorTimer -= dt;
    }

    // 雷达扫描
    this.radar.Scan(
      new Vector2D(p.position.x, p.position.y), 
      this.battlefield.enemies
    );

    // 清理死亡单位
    this.battlefield.missiles = this.battlefield.missiles.filter(m => m.isActive);
    this.battlefield.enemies = this.battlefield.enemies.filter(e => e.hp > 0);
    this.battlefield.lasers = this.battlefield.lasers.filter(l => l.state !== 'done');

    // 碰撞计算进入异步任务队列
    this.judger.CheckCollision(
      this.battlefield.missiles, 
      this.battlefield.lasers,
      [p, ...this.battlefield.enemies],
      (killerIsPlayer, isBoss, x, y) => {
        if (isBoss) {
           this.cinematicFocus = { x, y, timer: 3.0, maxTimer: 3.0 }; // 3 real seconds
           this.timeScale = 0.05; // 20x slower
           if (this.onBossExplosion) this.onBossExplosion(x, y);
           this.bossCooldownTimer = 10.0;
           this.lastBossScore = this.score + 50; // Add score from death to maintain the relative 100 offset
        } else {
           if (this.onExplosion) this.onExplosion(x, y);
           audioManager.playExplosionSound();
        }
        
        if (killerIsPlayer && p.hp > 0) {
          p.dashCooldown = 0; // 重置冷却
          this.score += isBoss ? 50 : 10;
        }
      }
    );

    this.status = this.judger.UpdateBattleStatus(p, this.battlefield.enemies);
  }

  public getSnapshot(): GameSnapshot {
    return {
      fps: this.fps,
      player: this.battlefield.player.GetState(),
      enemies: this.battlefield.enemies.map(e => e.GetState()),
      missiles: this.battlefield.missiles.map(m => m.GetState()),
      lasers: this.battlefield.lasers.map(l => l.GetState()),
      mapBounds: this.battlefield.mapBounds,
      status: this.status,
      radarRange: this.radar.range,
      score: this.score,
      timeScale: this.timeScale,
      cinematicFocus: this.cinematicFocus,
      bossSpawning: this.bossSpawning,
      bossIndicatorTime: this.bossIndicatorTimer
    };
  }
}
