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

export type NetworkProtocolVersion = 1;

// 预留网络对战接口，当前先统一为可版本化的 JSON 协议。
export enum NetMessageType {
  MSG_FIGHTER_MOVE = 'fighter_move',
  MSG_MISSILE_LAUNCH = 'missile_launch',
  MSG_HIT_RESULT = 'hit_result',
  MSG_BATTLE_STATUS = 'battle_status',
  MSG_ROOM_JOIN = 'room_join',
  MSG_ROOM_STATE = 'room_state',
  MSG_PLAYER_READY = 'player_ready',
  MSG_PLAYER_INPUT = 'player_input',
  MSG_STATE_SNAPSHOT = 'state_snapshot',
  MSG_COMBAT_EVENT = 'combat_event',
  MSG_HEARTBEAT = 'heartbeat',
  MSG_RESYNC_REQUEST = 'resync_request',
  MSG_RESYNC_STATE = 'resync_state',
}

export enum NetworkErrorCode {
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
  MISSING_FIELD = 'MISSING_FIELD',
  INVALID_ROOM_STATE = 'INVALID_ROOM_STATE',
  INVALID_SEQUENCE = 'INVALID_SEQUENCE',
}

export type NetworkFaction = 'red' | 'blue';
export type RoomPhase = 'waiting' | 'ready' | 'running' | 'finished';
export type CombatEventType =
  | 'missile_launch'
  | 'hit_result'
  | 'fighter_destroyed'
  | 'battle_status';
export type ResyncReason = 'snapshot_gap' | 'state_divergence' | 'reconnect';
export type ThrottleCommand = 'accelerate' | 'decelerate' | 'hold';
export type TurnCommand = 'left' | 'right' | 'hold';

export interface RoomPlayerInfo {
  playerId: string;
  playerName: string;
  faction: NetworkFaction;
  ready: boolean;
}

export interface NetworkPlayerInput {
  throttle: ThrottleCommand;
  turn: TurnCommand;
  fireMissile: boolean;
  fireBomb: boolean;
  targetId: string | null;
  aimHeading: number | null;
}

export interface FighterMovePayload {
  fighterId: string;
  position: Vector2DData;
  heading: number;
  speed: number;
}

export interface MissileLaunchPayload {
  missileId: string;
  ownerId: string;
  position: Vector2DData;
  heading: number;
  targetId: string | null;
}

export interface HitResultPayload {
  attackerId: string;
  targetId: string;
  damage: number;
  destroyed: boolean;
}

export interface BattleStatusPayload {
  status: GameSnapshot['status'];
  redRemaining: number;
  blueRemaining: number;
  score: number;
}

export interface RoomJoinPayload {
  roomId: string;
  playerId: string;
  playerName: string;
  faction: NetworkFaction;
}

export interface RoomStatePayload {
  roomId: string;
  phase: RoomPhase;
  hostPlayerId: string;
  maxPlayers: number;
  players: RoomPlayerInfo[];
}

export interface PlayerReadyPayload {
  ready: boolean;
  readyPlayers: string[];
}

export interface PlayerInputPayload {
  acknowledgedTick: number;
  input: NetworkPlayerInput;
}

export interface StateSnapshotPayload {
  snapshotId: string;
  serverTick: number;
  lastProcessedInputSequence: number;
  state: GameSnapshot;
}

export interface CombatEventPayload {
  eventId: string;
  eventType: CombatEventType;
  actorPlayerId: string;
  targetId: string | null;
  position: Vector2DData | null;
  battleStatus: GameSnapshot['status'] | null;
}

export interface HeartbeatPayload {
  pingMs: number;
  serverTime: number;
  acknowledgedTick: number;
}

export interface ResyncRequestPayload {
  requestedTick: number;
  reason: ResyncReason;
}

export interface ResyncStatePayload {
  fromTick: number;
  toTick: number;
  snapshot: GameSnapshot;
  recentEvents: CombatEventPayload[];
}

export type NetworkConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export type NetworkSyncState =
  | 'joining'
  | 'waiting_room'
  | 'syncing'
  | 'live'
  | 'stale'
  | 'disconnected';

export interface NetworkHudSnapshot {
  connectionState: NetworkConnectionState;
  syncState: NetworkSyncState;
  roomId: string;
  roomPhase: RoomPhase | null;
  localPlayerId: string;
  localPlayerName: string;
  localFaction: NetworkFaction;
  remotePlayers: RoomPlayerInfo[];
  pingMs: number | null;
  lastServerTick: number | null;
  lastProcessedInputSequence: number;
  lastHeartbeatAt: number | null;
  disconnectReason: string | null;
  errorMessage: string | null;
}

export interface GameViewSnapshot {
  game: GameSnapshot;
  network: NetworkHudSnapshot;
}

export interface NetworkMessageBase<
  TType extends NetMessageType,
  TPayload,
> {
  type: TType;
  version: NetworkProtocolVersion;
  roomId: string;
  playerId: string;
  tick: number;
  inputSequence: number;
  sentAt: number;
  payload: TPayload;
  errorCode?: NetworkErrorCode;
  errorMessage?: string;
}

export type FighterMoveMessage = NetworkMessageBase<
  NetMessageType.MSG_FIGHTER_MOVE,
  FighterMovePayload
>;
export type MissileLaunchMessage = NetworkMessageBase<
  NetMessageType.MSG_MISSILE_LAUNCH,
  MissileLaunchPayload
>;
export type HitResultMessage = NetworkMessageBase<
  NetMessageType.MSG_HIT_RESULT,
  HitResultPayload
>;
export type BattleStatusMessage = NetworkMessageBase<
  NetMessageType.MSG_BATTLE_STATUS,
  BattleStatusPayload
>;
export type RoomJoinMessage = NetworkMessageBase<
  NetMessageType.MSG_ROOM_JOIN,
  RoomJoinPayload
>;
export type RoomStateMessage = NetworkMessageBase<
  NetMessageType.MSG_ROOM_STATE,
  RoomStatePayload
>;
export type PlayerReadyMessage = NetworkMessageBase<
  NetMessageType.MSG_PLAYER_READY,
  PlayerReadyPayload
>;
export type PlayerInputMessage = NetworkMessageBase<
  NetMessageType.MSG_PLAYER_INPUT,
  PlayerInputPayload
>;
export type StateSnapshotMessage = NetworkMessageBase<
  NetMessageType.MSG_STATE_SNAPSHOT,
  StateSnapshotPayload
>;
export type CombatEventMessage = NetworkMessageBase<
  NetMessageType.MSG_COMBAT_EVENT,
  CombatEventPayload
>;
export type HeartbeatMessage = NetworkMessageBase<
  NetMessageType.MSG_HEARTBEAT,
  HeartbeatPayload
>;
export type ResyncRequestMessage = NetworkMessageBase<
  NetMessageType.MSG_RESYNC_REQUEST,
  ResyncRequestPayload
>;
export type ResyncStateMessage = NetworkMessageBase<
  NetMessageType.MSG_RESYNC_STATE,
  ResyncStatePayload
>;

export type NetworkMessage =
  | FighterMoveMessage
  | MissileLaunchMessage
  | HitResultMessage
  | BattleStatusMessage
  | RoomJoinMessage
  | RoomStateMessage
  | PlayerReadyMessage
  | PlayerInputMessage
  | StateSnapshotMessage
  | CombatEventMessage
  | HeartbeatMessage
  | ResyncRequestMessage
  | ResyncStateMessage;

export interface INetworkProtocol {
  Serialize(message: NetworkMessage): string;
  Deserialize(payload: string): NetworkMessage;
  GetMessageType(payload: string): NetMessageType;
  Validate(message: unknown): NetworkMessage;
}
