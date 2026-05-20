import { 
  IFighter, 
  IMissile, 
  GameSnapshot, 
  FighterSnapshot, 
  MissileSnapshot,
  LaserSnapshot,
  Vector2DData,
} from './interfaces';

// --- Math & Utils ---
export class Vector2D implements Vector2DData {
  constructor(public x: number, public y: number) {}

  add(v: Vector2DData) { return new Vector2D(this.x + v.x, this.y + v.y); }
  sub(v: Vector2DData) { return new Vector2D(this.x - v.x, this.y - v.y); }
  mag() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  normalize() {
    const m = this.mag();
    return m === 0 ? new Vector2D(0, 0) : new Vector2D(this.x / m, this.y / m);
  }
  mult(n: number) { return new Vector2D(this.x * n, this.y * n); }
  distanceTo(v: Vector2DData) { return this.sub(v).mag(); }
}

// --- Base Entities (Strictly Model, NO UI) ---
let idCounter = 0;
function generateId() { return `obj_${++idCounter}`; }

export class Missile implements IMissile {
  public id = generateId();
  public position = new Vector2D(0, 0);
  public velocity = new Vector2D(0, 0);
  public damage = 50;
  public isActive = true;
  private lifeTime = 5; // seconds
  public target: IFighter | null = null;
  public speed = 800; // pixels per sec
  public isPlayerMissile = true;
  public homingType: 'full' | 'semi' | 'none' = 'full';

  Launch(origin: Vector2DData, heading: number) {
    this.position = new Vector2D(origin.x, origin.y);
    this.velocity = new Vector2D(Math.cos(heading) * this.speed, Math.sin(heading) * this.speed);
  }

  Track(target: IFighter | null, dt: number) {
    if (!target || target.hp <= 0 || this.homingType === 'none') return;
    // Simple Proportional Homing (Pure Pursuit for simplicity)
    const direction = new Vector2D(target.position.x - this.position.x, target.position.y - this.position.y).normalize();
    const desiredVelocity = direction.mult(this.speed);
    
    // Gradual turn
    const turnRate = this.homingType === 'full' ? 3.0 : 0.8; // semi-homing is much slower
    this.velocity = new Vector2D(
      this.velocity.x + (desiredVelocity.x - this.velocity.x) * turnRate * dt,
      this.velocity.y + (desiredVelocity.y - this.velocity.y) * turnRate * dt
    );
    this.velocity = this.velocity.normalize().mult(this.speed);
  }

  Detonate() {
    this.isActive = false;
  }

  Update(dt: number) {
    if (!this.isActive) return;
    this.lifeTime -= dt;
    if (this.lifeTime <= 0) {
      this.Detonate();
      return;
    }
    if (this.target) {
      this.Track(this.target, dt);
    }
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
  }

  GetState(): MissileSnapshot {
    return {
      id: this.id,
      x: this.position.x,
      y: this.position.y,
      heading: Math.atan2(this.velocity.y, this.velocity.x),
      isPlayerMissile: this.isPlayerMissile
    };
  }
}

export class Laser {
  public id = generateId();
  public position = new Vector2D(0, 0);
  public heading = 0;
  public width = 100;
  public length = 2000;
  public state: 'telegraph' | 'firing' | 'done' = 'telegraph';
  public timer = 1.0; 
  public damage = 500;
  public hasHit = false;

  constructor(x: number, y: number, heading: number) {
    this.position = new Vector2D(x, y);
    this.heading = heading;
  }

  Update(dt: number) {
    this.timer -= dt;
    if (this.state === 'telegraph' && this.timer <= 0) {
      this.state = 'firing';
      this.timer = 0.5; // Fire duration
    } else if (this.state === 'firing' && this.timer <= 0) {
      this.state = 'done';
    }
  }

  GetState(): LaserSnapshot {
    return {
      id: this.id,
      x: this.position.x,
      y: this.position.y,
      heading: this.heading,
      width: this.width,
      length: this.length,
      state: this.state,
      progress: this.state === 'telegraph' ? 1.0 - this.timer : (0.5 - this.timer) / 0.5
    };
  }
}

export class Fighter implements IFighter {
  public id = generateId();
  public position = new Vector2D(0, 0);
  public velocity = new Vector2D(0, 0);
  public maxSpeed = 400;
  public speed = 0;
  public heading = 0;
  public hp = 100;
  public maxHp = 100;
  public type = "Fighter";
  public fireCooldown = 0;
  public inRadarRange = true; // Set by radar system dynamically
  public dashCooldown = 0;
  public isDashing = false;
  public dashTime = 0;
  public dashDirection = new Vector2D(0, 0);
  public isBoss = false;
  public laserCooldown = 0;

  constructor(public isPlayer: boolean, isBoss: boolean = false) {
    this.isBoss = isBoss;
    if (isPlayer) {
      this.type = "J-20威龙";
      this.maxSpeed = 500;
      this.hp = 200;
      this.maxHp = 200;
    } else if (isBoss) {
      this.type = "B-21突袭者(Boss)";
      this.maxSpeed = 150;
      this.hp = 2000;
      this.maxHp = 2000;
      this.laserCooldown = 5.0; // Shoot laser every ~5s
    } else {
      this.type = "F-22猛禽";
      this.maxSpeed = 350;
    }
  }

  Move(dt: number) {
    if (this.isPlayer) {
      if (this.isDashing) {
         this.dashTime -= dt;
         if (this.dashTime <= 0) {
           this.isDashing = false;
         } else {
           this.position.x += this.dashDirection.x * 1200 * dt;
           this.position.y += this.dashDirection.y * 1200 * dt;
           return;
         }
      }
      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
    } else {
      // Pause boss movement while channeling laser (cooldown just reset to 5s, channel takes 1.5s)
      if (this.isBoss && this.laserCooldown > 3.5) {
         return; 
      }
      this.velocity = new Vector2D(Math.cos(this.heading) * this.speed, Math.sin(this.heading) * this.speed);
      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
    }
  }

  Dash(heading: number) {
    if (this.dashCooldown <= 0) {
      this.isDashing = true;
      this.dashTime = 0.2; // 0.2s dash
      this.dashCooldown = 5.0; // 5s cooldown
      this.dashDirection = new Vector2D(Math.cos(heading), Math.sin(heading));
    }
  }

  Fire(target?: IFighter, targetHeading?: number): IMissile | null {
    if (this.fireCooldown > 0) return null;
    this.fireCooldown = this.isPlayer ? 0.15 : 1.0; // 0.15s cooldown for player
    const missile = new Missile();
    missile.Launch(this.position, targetHeading !== undefined ? targetHeading : this.heading);
    if (target) missile.target = target;
    return missile;
  }

  TakeDamage(amount: number) {
    this.hp -= amount;
    if (this.hp < 0) this.hp = 0;
  }

  Update(dt: number, bounds: { width: number, height: number }) {
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.laserCooldown > 0) this.laserCooldown -= dt;
    this.Move(dt);

    // Keep player within bounds (or enemies)
    if (this.position.x < 0) this.position.x = 0;
    if (this.position.y < 0) this.position.y = 0;
    if (this.position.x > bounds.width) this.position.x = bounds.width;
    if (this.position.y > bounds.height) this.position.y = bounds.height;
  }

  GetState(): FighterSnapshot {
    return {
      id: this.id,
      isPlayer: this.isPlayer,
      isBoss: this.isBoss,
      type: this.type,
      x: this.position.x,
      y: this.position.y,
      heading: this.heading,
      hp: this.hp,
      maxHp: this.maxHp,
      speed: this.speed,
      inRadarRange: this.isPlayer ? true : this.inRadarRange,
      dashCooldown: this.dashCooldown,
      isDashing: this.isDashing
    };
  }
}

export class Battlefield {
  public mapBounds = { width: 3000, height: 3000 };
  public player: Fighter;
  public enemies: Fighter[] = [];
  public missiles: Missile[] = [];
  public lasers: Laser[] = [];
  
  constructor() {
    this.player = new Fighter(true);
    this.player.position = new Vector2D(1500, 1500);
    
    // Spawn 8 enemies randomly at the edges
    for (let i = 0; i < 8; i++) {
      const enemy = new Fighter(false);
      enemy.position = new Vector2D(
        Math.random() < 0.5 ? 100 : this.mapBounds.width - 100,
        Math.random() * this.mapBounds.height
      );
      this.enemies.push(enemy);
    }
  }
}
