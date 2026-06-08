import type {
    CombatEventMessage,
    FighterSnapshot,
    NetworkPlayerInput,
    ResyncReason,
    ResyncStateMessage,
    StateSnapshotMessage,
} from './interfaces.ts';

export interface ClientSyncTrackerConfig {
    snapshotGapThreshold: number;
    divergenceDistanceThreshold: number;
    divergenceResyncThreshold: number;
    maxAcceptedEventLagTicks?: number;
}

export type AcceptanceStatus = 'accepted' | 'duplicate' | 'expired';

export interface SnapshotAcceptanceResult {
    status: AcceptanceStatus;
    shouldRequestResync: boolean;
    requestedTick: number | null;
    reason: ResyncReason | null;
}

export interface GenericAcceptanceResult {
    status: AcceptanceStatus;
}

export interface DivergenceDecision {
    action: 'none' | 'smooth_correct' | 'request_resync';
    distance: number;
    headingDelta: number;
}

export interface LocalPredictionConfig {
    tickDurationMs: number;
    speedStepPerTick: number;
    minSpeed: number;
    maxSpeed: number;
    turnStepPerTick: number;
}

const DEFAULT_MAX_ACCEPTED_EVENT_LAG_TICKS = 4;

function clamp(value: number, minValue: number, maxValue: number): number {
    return Math.min(Math.max(value, minValue), maxValue);
}

function normalizeAngle(angle: number): number {
    let normalized = angle;
    while (normalized > Math.PI) {
        normalized -= Math.PI * 2;
    }
    while (normalized < -Math.PI) {
        normalized += Math.PI * 2;
    }
    return normalized;
}

function distanceBetween(a: FighterSnapshot, b: FighterSnapshot): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function interpolateFighterCorrection(
    from: FighterSnapshot,
    to: FighterSnapshot,
    progress: number,
): FighterSnapshot {
    const normalizedProgress = clamp(progress, 0, 1);
    const headingDelta = normalizeAngle(to.heading - from.heading);

    return {
        ...to,
        x: from.x + (to.x - from.x) * normalizedProgress,
        y: from.y + (to.y - from.y) * normalizedProgress,
        heading: normalizeAngle(from.heading + headingDelta * normalizedProgress),
        hp: from.hp + (to.hp - from.hp) * normalizedProgress,
        speed: from.speed + (to.speed - from.speed) * normalizedProgress,
        dashCooldown: from.dashCooldown + (to.dashCooldown - from.dashCooldown) * normalizedProgress,
    };
}

export function predictLocalFighter(
    fighter: FighterSnapshot,
    input: NetworkPlayerInput,
    dtSeconds: number,
    mapBounds: { width: number; height: number },
    config: LocalPredictionConfig,
): FighterSnapshot {
    const safeDtSeconds = Math.max(dtSeconds, 0);
    const tickSeconds = config.tickDurationMs / 1000;
    const speedStepPerSecond = config.speedStepPerTick / tickSeconds;
    const turnStepPerSecond = config.turnStepPerTick / tickSeconds;

    let heading = fighter.heading;
    let speed = fighter.speed;

    if (input.aimHeading !== null) {
        heading = normalizeAngle(input.aimHeading);
    } else if (input.turn === 'left') {
        heading = normalizeAngle(heading - turnStepPerSecond * safeDtSeconds);
    } else if (input.turn === 'right') {
        heading = normalizeAngle(heading + turnStepPerSecond * safeDtSeconds);
    }

    if (input.throttle === 'accelerate') {
        speed = clamp(speed + speedStepPerSecond * safeDtSeconds, config.minSpeed, config.maxSpeed);
    } else if (input.throttle === 'decelerate') {
        speed = clamp(speed - speedStepPerSecond * safeDtSeconds, config.minSpeed, config.maxSpeed);
    }

    return {
        ...fighter,
        heading,
        speed,
        x: clamp(fighter.x + Math.cos(heading) * speed * safeDtSeconds, 0, mapBounds.width),
        y: clamp(fighter.y + Math.sin(heading) * speed * safeDtSeconds, 0, mapBounds.height),
    };
}

/**
 * 统一管理客户端对快照、事件与重同步消息的顺序判定，避免不同消息类型各自维护隐式状态。
 */
export class ClientSyncTracker {
    private readonly config: ClientSyncTrackerConfig;

    private lastSnapshotTick: number;

    private lastSnapshotInputSequence: number;

    private lastRoomStateTick: number;

    private lastHeartbeatTick: number;

    private lastResyncTick: number;

    private recentEventIds: Set<string>;

    constructor(config: ClientSyncTrackerConfig) {
        this.config = config;
        this.lastSnapshotTick = 0;
        this.lastSnapshotInputSequence = 0;
        this.lastRoomStateTick = 0;
        this.lastHeartbeatTick = 0;
        this.lastResyncTick = 0;
        this.recentEventIds = new Set<string>();
    }

    reset(): void {
        this.lastSnapshotTick = 0;
        this.lastSnapshotInputSequence = 0;
        this.lastRoomStateTick = 0;
        this.lastHeartbeatTick = 0;
        this.lastResyncTick = 0;
        this.recentEventIds.clear();
    }

    getLastSnapshotTick(): number {
        return this.lastSnapshotTick;
    }

    acceptRoomState(tick: number): GenericAcceptanceResult {
        if (tick < this.lastRoomStateTick) {
            return { status: 'expired' };
        }
        if (tick === this.lastRoomStateTick && tick !== 0) {
            return { status: 'duplicate' };
        }

        this.lastRoomStateTick = tick;
        return { status: 'accepted' };
    }

    acceptHeartbeat(acknowledgedTick: number): GenericAcceptanceResult {
        if (acknowledgedTick < this.lastHeartbeatTick) {
            return { status: 'expired' };
        }
        if (acknowledgedTick === this.lastHeartbeatTick && acknowledgedTick !== 0) {
            return { status: 'duplicate' };
        }

        this.lastHeartbeatTick = acknowledgedTick;
        return { status: 'accepted' };
    }

    acceptCombatEvent(message: CombatEventMessage): GenericAcceptanceResult {
        if (this.recentEventIds.has(message.payload.eventId)) {
            return { status: 'duplicate' };
        }

        const maxAcceptedEventLagTicks = this.config.maxAcceptedEventLagTicks ?? DEFAULT_MAX_ACCEPTED_EVENT_LAG_TICKS;
        if (
            this.lastSnapshotTick > 0
            && message.tick < this.lastSnapshotTick - maxAcceptedEventLagTicks
            && message.inputSequence <= this.lastSnapshotInputSequence
        ) {
            return { status: 'expired' };
        }

        this.recentEventIds.add(message.payload.eventId);
        if (this.recentEventIds.size > 64) {
            const oldestEventId = this.recentEventIds.values().next().value;
            if (oldestEventId) {
                this.recentEventIds.delete(oldestEventId);
            }
        }

        return { status: 'accepted' };
    }

    acceptStateSnapshot(message: StateSnapshotMessage): SnapshotAcceptanceResult {
        const previousTick = this.lastSnapshotTick;
        const snapshotTick = message.payload.serverTick;
        const inputSequence = message.payload.lastProcessedInputSequence;

        if (snapshotTick < previousTick) {
            return {
                status: 'expired',
                shouldRequestResync: false,
                requestedTick: null,
                reason: null,
            };
        }

        if (snapshotTick === previousTick && inputSequence <= this.lastSnapshotInputSequence && snapshotTick !== 0) {
            return {
                status: 'duplicate',
                shouldRequestResync: false,
                requestedTick: null,
                reason: null,
            };
        }

        this.lastSnapshotTick = snapshotTick;
        this.lastSnapshotInputSequence = Math.max(this.lastSnapshotInputSequence, inputSequence);

        const missedTicks = previousTick === 0 ? 0 : Math.max(0, snapshotTick - previousTick - 1);
        const shouldRequestResync = missedTicks >= this.config.snapshotGapThreshold;

        return {
            status: 'accepted',
            shouldRequestResync,
            requestedTick: shouldRequestResync ? previousTick + 1 : null,
            reason: shouldRequestResync ? 'snapshot_gap' : null,
        };
    }

    acceptResyncState(message: ResyncStateMessage): GenericAcceptanceResult {
        const { toTick } = message.payload;

        if (toTick < this.lastSnapshotTick || toTick < this.lastResyncTick) {
            return { status: 'expired' };
        }
        if (toTick === this.lastResyncTick && toTick !== 0) {
            return { status: 'duplicate' };
        }

        this.lastResyncTick = toTick;
        this.lastSnapshotTick = toTick;
        this.lastSnapshotInputSequence = Math.max(this.lastSnapshotInputSequence, message.inputSequence);
        return { status: 'accepted' };
    }

    evaluateDivergence(localPlayer: FighterSnapshot, authoritativePlayer: FighterSnapshot): DivergenceDecision {
        const distance = distanceBetween(localPlayer, authoritativePlayer);
        const headingDelta = Math.abs(normalizeAngle(authoritativePlayer.heading - localPlayer.heading));

        if (distance >= this.config.divergenceResyncThreshold) {
            return {
                action: 'request_resync',
                distance,
                headingDelta,
            };
        }

        if (distance >= this.config.divergenceDistanceThreshold || headingDelta >= 0.35) {
            return {
                action: 'smooth_correct',
                distance,
                headingDelta,
            };
        }

        return {
            action: 'none',
            distance,
            headingDelta,
        };
    }
}
