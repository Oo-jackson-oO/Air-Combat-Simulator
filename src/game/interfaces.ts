export interface Vector2DData {
  x: number;
  y: number;
}

export interface GameSnapshot {
  fps: number;
  player: FighterSnapshot | null;
  enemies: FighterSnapshot[];
  missiles: MissileSnapshot[];
  lasers: LaserSnapshot[];
  mapBounds: { width: number; height: number };
  status: 'playing' | 'defeat';
  radarRange: number;
  score: number;
  timeScale: number;
  cinematicFocus: { x: number, y: number, timer: number, maxTimer: number } | null;
  bossSpawning: boolean;
  bossIndicatorTime: number;
}

export interface LaserSnapshot {
  id: string;
  x: number;
  y: number;
  heading: number;
  width: number;
  length: number;
  state: 'telegraph' | 'firing' | 'done';
  progress: number;
}

export interface FighterSnapshot {
  id: string;
  isPlayer: boolean;
  isBoss: boolean;
  type: string;
  x: number;
  y: number;
  heading: number;
  hp: number;
  maxHp: number;
  speed: number;
  inRadarRange: boolean;
  dashCooldown: number;
  isDashing: boolean;
}

export interface MissileSnapshot {
  id: string;
  x: number;
  y: number;
  heading: number;
  isPlayerMissile: boolean;
}

export interface IFighter {
  id: string;
  position: Vector2DData;
  velocity: Vector2DData;
  speed: number;
  maxSpeed: number;
  heading: number; // in radians
  hp: number;
  isPlayer: boolean;
  isBoss?: boolean;
  dashCooldown: number;
  laserCooldown?: number;
  inRadarRange?: boolean;
  
  Move(dt: number): void;
  Dash(heading: number): void;
  Fire(target?: IFighter, targetHeading?: number): IMissile | null;
  TakeDamage(amount: number): void;
  GetState(): FighterSnapshot;
  Update(dt: number, bounds: { width: number, height: number }): void;
}

export interface IMissile {
  id: string;
  position: Vector2DData;
  velocity: Vector2DData;
  damage: number;
  isActive: boolean;
  isPlayerMissile: boolean;
  homingType: 'full' | 'semi' | 'none';
  
  Launch(origin: Vector2DData, heading: number): void;
  Track(target: IFighter | null, dt: number): void;
  Detonate(): void;
  Update(dt: number): void;
  GetState(): MissileSnapshot;
}

export interface IRadarSystem {
  range: number;
  Scan(origin: Vector2DData, targets: IFighter[]): IFighter[];
  SetRange(range: number): void;
}

export interface ICombatJudger {
  CheckCollision(missiles: IMissile[], lasers: unknown[], fighters: IFighter[], onKill?: (killerIsPlayer: boolean, isBoss: boolean | undefined, x: number, y: number) => void): void;
  JudgeHit(missile: IMissile, fighter: IFighter): boolean;
  UpdateBattleStatus(player: IFighter, enemies: IFighter[]): 'playing' | 'defeat';
  onExplosion?: (x: number, y: number) => void;
}

export interface IAIController {
  Decide(dt: number, enemies: IFighter[], player: IFighter): any;
  Execute(): void;
  SetDifficulty(level: number): void;
}

// 预留网络对战接口
export enum NetMessageType {
  MSG_FIGHTER_MOVE,
  MSG_MISSILE_LAUNCH,
  MSG_HIT_RESULT,
  MSG_BATTLE_STATUS
}

export interface INetworkProtocol {
  Serialize(data: any, type: NetMessageType): string;
  Deserialize(payload: string): any;
  GetMessageType(payload: string): NetMessageType;
}
