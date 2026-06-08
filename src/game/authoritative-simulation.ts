import type {
    CombatEventPayload,
    FighterSnapshot,
    GameSnapshot,
    MissileSnapshot,
    NetworkFaction,
    NetworkPlayerInput,
    RoomPlayerInfo,
    Vector2DData,
} from './interfaces.ts';

interface SimulationFighter {
    id: string;
    playerId: string;
    playerName: string;
    faction: NetworkFaction;
    isPlayerControlled: boolean;
    isPrimaryView: boolean;
    x: number;
    y: number;
    heading: number;
    speed: number;
    hp: number;
    maxHp: number;
    weaponCooldownTicks: number;
}

interface SimulationMissile {
    id: string;
    ownerId: string;
    ownerFaction: NetworkFaction;
    x: number;
    y: number;
    heading: number;
    speed: number;
    targetId: string | null;
    damage: number;
    remainingTicks: number;
    active: boolean;
}

export interface QueuedSimulationInput {
    playerId: string;
    inputSequence: number;
    input: NetworkPlayerInput;
}

export interface AuthoritativeSimulationConfig {
    tickDurationMs: number;
    mapWidth: number;
    mapHeight: number;
    radarRange: number;
    snapshotFps: number;
    playerHp: number;
    playerSpeed: number;
    enemyHp: number;
    enemySpeed: number;
    missileDamage: number;
    missileSpeed: number;
    missileLifetimeTicks: number;
    weaponCooldownTicks: number;
    aiFireCooldownTicks: number;
    aiCount: number;
}

export interface AuthoritativeSimulationStepResult {
    serverTick: number;
    snapshot: GameSnapshot;
    events: CombatEventPayload[];
    lastProcessedInputSequence: number;
    battleFinished: boolean;
}

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.min(Math.max(value, minValue), maxValue);
}

function normalizeAngle(angle: number): number {
    let normalizedAngle = angle;

    while (normalizedAngle > Math.PI) {
        normalizedAngle -= Math.PI * 2;
    }

    while (normalizedAngle < -Math.PI) {
        normalizedAngle += Math.PI * 2;
    }

    return normalizedAngle;
}

function distanceBetween(a: Vector2DData, b: Vector2DData): number {
    const deltaX = a.x - b.x;
    const deltaY = a.y - b.y;
    return Math.hypot(deltaX, deltaY);
}

function turnTowards(currentHeading: number, targetHeading: number, maxTurnStep: number): number {
    const angleDelta = normalizeAngle(targetHeading - currentHeading);
    const clampedDelta = clamp(angleDelta, -maxTurnStep, maxTurnStep);
    return normalizeAngle(currentHeading + clampedDelta);
}

/**
 * 服务器权威模拟核心只处理纯战场计算，避免把网络房间编排与模型推进耦合在一起。
 */
export class AuthoritativeBattleSimulation {
    private readonly config: AuthoritativeSimulationConfig;

    private currentTick: number;

    private score: number;

    private status: GameSnapshot['status'];

    private readonly fighters: SimulationFighter[];

    private readonly missiles: SimulationMissile[];

    private identityCounter: number;

    constructor(config: AuthoritativeSimulationConfig) {
        this.config = config;
        this.currentTick = 0;
        this.score = 0;
        this.status = 'playing';
        this.fighters = [];
        this.missiles = [];
        this.identityCounter = 0;
    }

    /**
     * 基于房间玩家列表重建一份确定性的战场初始态，保证房间开局后每次都从同样的权威状态出发。
     */
    reset(players: RoomPlayerInfo[]): void {
        this.currentTick = 0;
        this.score = 0;
        this.status = 'playing';
        this.fighters.length = 0;
        this.missiles.length = 0;
        this.identityCounter = 0;

        const primaryPlayerId = this.resolvePrimaryPlayerId(players);
        const playerCount = players.length;

        players.forEach((player, index) => {
            const horizontalSpacing = playerCount > 1 ? 280 : 0;
            const spawnOffset = (index - (playerCount - 1) / 2) * horizontalSpacing;
            const spawnX = player.faction === 'red' ? 900 : 2100;
            const spawnY = 1500 + spawnOffset;
            const spawnHeading = player.faction === 'red' ? 0 : Math.PI;

            this.fighters.push({
                id: player.playerId,
                playerId: player.playerId,
                playerName: player.playerName,
                faction: player.faction,
                isPlayerControlled: true,
                isPrimaryView: player.playerId === primaryPlayerId,
                x: spawnX,
                y: spawnY,
                heading: spawnHeading,
                speed: this.config.playerSpeed,
                hp: this.config.playerHp,
                maxHp: this.config.playerHp,
                weaponCooldownTicks: 0,
            });
        });

        for (let index = 0; index < this.config.aiCount; index += 1) {
            const spawnY = 900 + index * 320;
            this.fighters.push({
                id: this.allocateId('ai'),
                playerId: `ai-${index + 1}`,
                playerName: `敌机-${index + 1}`,
                faction: 'blue',
                isPlayerControlled: false,
                isPrimaryView: false,
                x: 2250,
                y: spawnY,
                heading: Math.PI,
                speed: this.config.enemySpeed,
                hp: this.config.enemyHp,
                maxHp: this.config.enemyHp,
                weaponCooldownTicks: this.config.aiFireCooldownTicks,
            });
        }
    }

    getCurrentTick(): number {
        return this.currentTick;
    }

    buildSnapshotForPlayer(playerId: string): GameSnapshot {
        const localFighter = this.fighters.find((fighter) => fighter.playerId === playerId) ?? null;

        if (!localFighter) {
            return this.buildSnapshot();
        }

        const enemySnapshots: FighterSnapshot[] = [];
        for (const fighter of this.fighters) {
            if (fighter.playerId === localFighter.playerId || fighter.faction === localFighter.faction) {
                continue;
            }

            enemySnapshots.push(this.toFighterSnapshot(fighter, localFighter));
        }

        return {
            fps: this.config.snapshotFps,
            player: this.toFighterSnapshot(localFighter, localFighter),
            enemies: enemySnapshots,
            missiles: this.missiles.map((missile) => this.toMissileSnapshot(missile, localFighter.faction)),
            lasers: [],
            mapBounds: {
                width: this.config.mapWidth,
                height: this.config.mapHeight,
            },
            status: this.status,
            radarRange: this.config.radarRange,
            score: this.score,
            timeScale: 1,
            cinematicFocus: null,
            bossSpawning: false,
            bossIndicatorTime: 0,
        };
    }

    /**
     * 每个逻辑节拍只消费当前节拍对应的输入，再统一推进玩家、AI、导弹和命中判定。
     */
    step(inputs: QueuedSimulationInput[]): AuthoritativeSimulationStepResult {
        this.currentTick += 1;

        const events: CombatEventPayload[] = [];
        const dtSeconds = this.config.tickDurationMs / 1000;
        let lastProcessedInputSequence = 0;

        for (const fighter of this.fighters) {
            fighter.weaponCooldownTicks = Math.max(0, fighter.weaponCooldownTicks - 1);
        }

        for (const queuedInput of inputs) {
            const fighter = this.findLivingFighter(queuedInput.playerId);

            if (!fighter || !fighter.isPlayerControlled) {
                continue;
            }

            lastProcessedInputSequence = Math.max(lastProcessedInputSequence, queuedInput.inputSequence);
            this.applyPlayerInput(fighter, queuedInput.input, events);
        }

        this.updateAi(events);
        this.moveFighters(dtSeconds);
        this.updateMissiles(dtSeconds, events);
        this.status = this.resolveBattleStatus();

        if (this.status === 'defeat') {
            events.push({
                eventId: this.allocateId('evt'),
                eventType: 'battle_status',
                actorPlayerId: 'server',
                targetId: null,
                position: null,
                battleStatus: this.status,
            });
        }

        return {
            serverTick: this.currentTick,
            snapshot: this.buildSnapshot(),
            events,
            lastProcessedInputSequence,
            battleFinished: this.isBattleFinished(),
        };
    }

    private resolvePrimaryPlayerId(players: RoomPlayerInfo[]): string {
        const redPlayer = players.find((player) => player.faction === 'red');
        const primaryPlayer = redPlayer ?? players[0];

        if (!primaryPlayer) {
            throw new Error('权威模拟启动失败：房间内没有可用玩家');
        }

        return primaryPlayer.playerId;
    }

    private allocateId(prefix: string): string {
        this.identityCounter += 1;
        return `${prefix}_${this.identityCounter}`;
    }

    private findLivingFighter(playerId: string): SimulationFighter | undefined {
        return this.fighters.find((fighter) => fighter.playerId === playerId && fighter.hp > 0);
    }

    private findNearestOpponent(source: SimulationFighter): SimulationFighter | null {
        const opponents = this.fighters.filter((fighter) => fighter.hp > 0 && fighter.faction !== source.faction);

        if (opponents.length === 0) {
            return null;
        }

        let nearestOpponent = opponents[0];
        let nearestDistance = distanceBetween(source, nearestOpponent);

        for (const opponent of opponents.slice(1)) {
            const currentDistance = distanceBetween(source, opponent);

            if (currentDistance < nearestDistance) {
                nearestOpponent = opponent;
                nearestDistance = currentDistance;
            }
        }

        return nearestOpponent;
    }

    private resolveTarget(source: SimulationFighter, requestedTargetId: string | null): SimulationFighter | null {
        if (requestedTargetId) {
            const requestedTarget = this.fighters.find(
                (fighter) => fighter.playerId === requestedTargetId && fighter.hp > 0 && fighter.faction !== source.faction,
            );

            if (requestedTarget) {
                return requestedTarget;
            }
        }

        return this.findNearestOpponent(source);
    }

    private applyPlayerInput(fighter: SimulationFighter, input: NetworkPlayerInput, events: CombatEventPayload[]): void {
        const speedStep = 35;
        const turnStep = 0.22;

        if (input.aimHeading !== null) {
            fighter.heading = normalizeAngle(input.aimHeading);
        } else if (input.turn === 'left') {
            fighter.heading = normalizeAngle(fighter.heading - turnStep);
        } else if (input.turn === 'right') {
            fighter.heading = normalizeAngle(fighter.heading + turnStep);
        }

        if (input.throttle === 'accelerate') {
            fighter.speed = clamp(fighter.speed + speedStep, 140, this.config.playerSpeed + 120);
        } else if (input.throttle === 'decelerate') {
            fighter.speed = clamp(fighter.speed - speedStep, 80, this.config.playerSpeed + 120);
        }

        if (input.fireMissile && fighter.weaponCooldownTicks === 0) {
            const target = this.resolveTarget(fighter, input.targetId);
            this.spawnMissile(fighter, target, events);
            fighter.weaponCooldownTicks = this.config.weaponCooldownTicks;
        }
    }

    private updateAi(events: CombatEventPayload[]): void {
        for (const fighter of this.fighters) {
            if (fighter.hp <= 0 || fighter.isPlayerControlled) {
                continue;
            }

            const target = this.findNearestOpponent(fighter);

            if (!target) {
                continue;
            }

            const desiredHeading = Math.atan2(target.y - fighter.y, target.x - fighter.x);
            fighter.heading = turnTowards(fighter.heading, desiredHeading, 0.12);

            if (fighter.weaponCooldownTicks === 0) {
                this.spawnMissile(fighter, target, events);
                fighter.weaponCooldownTicks = this.config.aiFireCooldownTicks;
            }
        }
    }

    private moveFighters(dtSeconds: number): void {
        for (const fighter of this.fighters) {
            if (fighter.hp <= 0) {
                continue;
            }

            fighter.x = clamp(
                fighter.x + Math.cos(fighter.heading) * fighter.speed * dtSeconds,
                0,
                this.config.mapWidth,
            );
            fighter.y = clamp(
                fighter.y + Math.sin(fighter.heading) * fighter.speed * dtSeconds,
                0,
                this.config.mapHeight,
            );
        }
    }

    private spawnMissile(
        source: SimulationFighter,
        target: SimulationFighter | null,
        events: CombatEventPayload[],
    ): void {
        const heading = target
            ? Math.atan2(target.y - source.y, target.x - source.x)
            : source.heading;

        const missile: SimulationMissile = {
            id: this.allocateId('missile'),
            ownerId: source.playerId,
            ownerFaction: source.faction,
            x: source.x,
            y: source.y,
            heading,
            speed: this.config.missileSpeed,
            targetId: target ? target.playerId : null,
            damage: this.config.missileDamage,
            remainingTicks: this.config.missileLifetimeTicks,
            active: true,
        };

        this.missiles.push(missile);
        events.push({
            eventId: this.allocateId('evt'),
            eventType: 'missile_launch',
            actorPlayerId: source.playerId,
            targetId: missile.targetId,
            position: { x: source.x, y: source.y },
            battleStatus: null,
        });
    }

    private updateMissiles(dtSeconds: number, events: CombatEventPayload[]): void {
        for (const missile of this.missiles) {
            if (!missile.active) {
                continue;
            }

            const target = missile.targetId
                ? this.fighters.find((fighter) => fighter.playerId === missile.targetId && fighter.hp > 0)
                : null;

            if (target) {
                const desiredHeading = Math.atan2(target.y - missile.y, target.x - missile.x);
                missile.heading = turnTowards(missile.heading, desiredHeading, 0.18);
            }

            missile.x += Math.cos(missile.heading) * missile.speed * dtSeconds;
            missile.y += Math.sin(missile.heading) * missile.speed * dtSeconds;
            missile.remainingTicks -= 1;

            if (missile.remainingTicks <= 0) {
                missile.active = false;
                continue;
            }

            const hitTarget = this.fighters.find((fighter) => {
                if (fighter.hp <= 0 || fighter.faction === missile.ownerFaction) {
                    return false;
                }

                return distanceBetween(missile, fighter) <= 40;
            });

            if (!hitTarget) {
                continue;
            }

            hitTarget.hp = Math.max(0, hitTarget.hp - missile.damage);
            missile.active = false;

            events.push({
                eventId: this.allocateId('evt'),
                eventType: 'hit_result',
                actorPlayerId: missile.ownerId,
                targetId: hitTarget.playerId,
                position: { x: hitTarget.x, y: hitTarget.y },
                battleStatus: null,
            });

            if (hitTarget.hp === 0) {
                if (missile.ownerFaction === 'red') {
                    this.score += 10;
                }

                events.push({
                    eventId: this.allocateId('evt'),
                    eventType: 'fighter_destroyed',
                    actorPlayerId: missile.ownerId,
                    targetId: hitTarget.playerId,
                    position: { x: hitTarget.x, y: hitTarget.y },
                    battleStatus: null,
                });
            }
        }

        for (let index = this.missiles.length - 1; index >= 0; index -= 1) {
            if (!this.missiles[index].active) {
                this.missiles.splice(index, 1);
            }
        }
    }

    private resolveBattleStatus(): GameSnapshot['status'] {
        const primaryFighter = this.fighters.find((fighter) => fighter.isPrimaryView);

        if (!primaryFighter || primaryFighter.hp <= 0) {
            return 'defeat';
        }

        return 'playing';
    }

    private isBattleFinished(): boolean {
        if (this.status === 'defeat') {
            return true;
        }

        const blueUnitsAlive = this.fighters.some((fighter) => fighter.hp > 0 && fighter.faction === 'blue');
        return !blueUnitsAlive;
    }

    private buildSnapshot(): GameSnapshot {
        const primaryFighter = this.fighters.find((fighter) => fighter.isPrimaryView) ?? null;
        const playerPosition = primaryFighter ? { x: primaryFighter.x, y: primaryFighter.y } : null;
        const enemySnapshots: FighterSnapshot[] = [];

        for (const fighter of this.fighters) {
            if (primaryFighter && fighter.playerId === primaryFighter.playerId) {
                continue;
            }

            enemySnapshots.push(this.toFighterSnapshot(fighter, playerPosition));
        }

        return {
            fps: this.config.snapshotFps,
            player: primaryFighter ? this.toFighterSnapshot(primaryFighter, playerPosition) : null,
            enemies: enemySnapshots,
            missiles: this.missiles.map((missile) => this.toMissileSnapshot(missile, primaryFighter?.faction ?? 'red')),
            lasers: [],
            mapBounds: {
                width: this.config.mapWidth,
                height: this.config.mapHeight,
            },
            status: this.status,
            radarRange: this.config.radarRange,
            score: this.score,
            timeScale: 1,
            cinematicFocus: null,
            bossSpawning: false,
            bossIndicatorTime: 0,
        };
    }

    private toFighterSnapshot(
        fighter: SimulationFighter,
        primaryPlayerPosition: Vector2DData | null,
    ): FighterSnapshot {
        const inRadarRange = primaryPlayerPosition
            ? distanceBetween(primaryPlayerPosition, fighter) <= this.config.radarRange
            : true;

        return {
            id: fighter.id,
            isPlayer: fighter.isPrimaryView,
            isBoss: false,
            type: fighter.playerName,
            x: fighter.x,
            y: fighter.y,
            heading: fighter.heading,
            hp: fighter.hp,
            maxHp: fighter.maxHp,
            speed: fighter.speed,
            inRadarRange,
            dashCooldown: 0,
            isDashing: false,
        };
    }

    private toMissileSnapshot(missile: SimulationMissile, localFaction: NetworkFaction): MissileSnapshot {
        return {
            id: missile.id,
            x: missile.x,
            y: missile.y,
            heading: missile.heading,
            isPlayerMissile: missile.ownerFaction === localFaction,
        };
    }
}
