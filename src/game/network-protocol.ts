import {
    NetMessageType,
    type CombatEventPayload,
    type HeartbeatPayload,
    type INetworkProtocol,
    type MissileLaunchPayload,
    type NetworkMessage,
    type NetworkPlayerInput,
    type PlayerInputPayload,
    type ResyncRequestPayload,
    type ResyncStatePayload,
    type RoomPlayerInfo,
    type RoomStatePayload,
    type Vector2DData,
} from './interfaces.ts';

const SUPPORTED_PROTOCOL_VERSION = 1;

function assertCondition(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, fieldName: string): Record<string, unknown> {
    assertCondition(isObjectRecord(value), `${fieldName} 必须是对象`);
    return value;
}

function readString(value: unknown, fieldName: string): string {
    assertCondition(typeof value === 'string' && value.length > 0, `${fieldName} 必须是非空字符串`);
    return value;
}

function readNumber(value: unknown, fieldName: string): number {
    assertCondition(typeof value === 'number' && Number.isFinite(value), `${fieldName} 必须是有限数字`);
    return value;
}

function readBoolean(value: unknown, fieldName: string): boolean {
    assertCondition(typeof value === 'boolean', `${fieldName} 必须是布尔值`);
    return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
    assertCondition(value === null || typeof value === 'string', `${fieldName} 必须是字符串或 null`);
    return value as string | null;
}

function readNullableNumber(value: unknown, fieldName: string): number | null {
    assertCondition(
        value === null || (typeof value === 'number' && Number.isFinite(value)),
        `${fieldName} 必须是数字或 null`,
    );
    return value as number | null;
}

function isNetMessageType(value: unknown): value is NetMessageType {
    return Object.values(NetMessageType).includes(value as NetMessageType);
}

function validateVector(value: unknown, fieldName: string): Vector2DData | null {
    if (value === null) {
        return null;
    }

    const record = readRecord(value, fieldName);
    return {
        x: readNumber(record.x, `${fieldName}.x`),
        y: readNumber(record.y, `${fieldName}.y`),
    };
}

function validateRoomPlayerInfo(value: unknown, fieldName: string): RoomPlayerInfo {
    const record = readRecord(value, fieldName);
    const faction = readString(record.faction, `${fieldName}.faction`);
    assertCondition(faction === 'red' || faction === 'blue', `${fieldName}.faction 必须是 red 或 blue`);

    return {
        playerId: readString(record.playerId, `${fieldName}.playerId`),
        playerName: readString(record.playerName, `${fieldName}.playerName`),
        faction,
        ready: readBoolean(record.ready, `${fieldName}.ready`),
    };
}

function validatePlayerInput(value: unknown, fieldName: string): NetworkPlayerInput {
    const record = readRecord(value, fieldName);
    const throttle = readString(record.throttle, `${fieldName}.throttle`);
    const turn = readString(record.turn, `${fieldName}.turn`);

    assertCondition(
        throttle === 'accelerate' || throttle === 'decelerate' || throttle === 'hold',
        `${fieldName}.throttle 必须是 accelerate、decelerate 或 hold`,
    );
    assertCondition(
        turn === 'left' || turn === 'right' || turn === 'hold',
        `${fieldName}.turn 必须是 left、right 或 hold`,
    );

    return {
        throttle,
        turn,
        fireMissile: readBoolean(record.fireMissile, `${fieldName}.fireMissile`),
        fireBomb: readBoolean(record.fireBomb, `${fieldName}.fireBomb`),
        targetId: readNullableString(record.targetId, `${fieldName}.targetId`),
        aimHeading: readNullableNumber(record.aimHeading, `${fieldName}.aimHeading`),
    };
}

function validateGameSnapshotShape(value: unknown, fieldName: string): void {
    const record = readRecord(value, fieldName);
    readNumber(record.fps, `${fieldName}.fps`);
    assertCondition(record.player === null || isObjectRecord(record.player), `${fieldName}.player 必须是对象或 null`);
    assertCondition(Array.isArray(record.enemies), `${fieldName}.enemies 必须是数组`);
    assertCondition(Array.isArray(record.missiles), `${fieldName}.missiles 必须是数组`);
    assertCondition(Array.isArray(record.lasers), `${fieldName}.lasers 必须是数组`);

    const mapBounds = readRecord(record.mapBounds, `${fieldName}.mapBounds`);
    readNumber(mapBounds.width, `${fieldName}.mapBounds.width`);
    readNumber(mapBounds.height, `${fieldName}.mapBounds.height`);

    const status = readString(record.status, `${fieldName}.status`);
    assertCondition(status === 'playing' || status === 'defeat', `${fieldName}.status 必须是 playing 或 defeat`);

    readNumber(record.radarRange, `${fieldName}.radarRange`);
    readNumber(record.score, `${fieldName}.score`);
    readNumber(record.timeScale, `${fieldName}.timeScale`);
    assertCondition(
        record.cinematicFocus === null || isObjectRecord(record.cinematicFocus),
        `${fieldName}.cinematicFocus 必须是对象或 null`,
    );
    readBoolean(record.bossSpawning, `${fieldName}.bossSpawning`);
    readNumber(record.bossIndicatorTime, `${fieldName}.bossIndicatorTime`);
}

function validateMissileLaunchPayload(value: unknown): MissileLaunchPayload {
    const record = readRecord(value, 'payload');
    return {
        missileId: readString(record.missileId, 'payload.missileId'),
        ownerId: readString(record.ownerId, 'payload.ownerId'),
        position: validateVector(record.position, 'payload.position') as Vector2DData,
        heading: readNumber(record.heading, 'payload.heading'),
        targetId: readNullableString(record.targetId, 'payload.targetId'),
    };
}

function validateRoomStatePayload(value: unknown): RoomStatePayload {
    const record = readRecord(value, 'payload');
    const phase = readString(record.phase, 'payload.phase');

    assertCondition(
        phase === 'waiting' || phase === 'ready' || phase === 'running' || phase === 'finished',
        'payload.phase 必须是 waiting、ready、running 或 finished',
    );
    assertCondition(Array.isArray(record.players), 'payload.players 必须是数组');

    return {
        roomId: readString(record.roomId, 'payload.roomId'),
        phase,
        hostPlayerId: readString(record.hostPlayerId, 'payload.hostPlayerId'),
        maxPlayers: readNumber(record.maxPlayers, 'payload.maxPlayers'),
        players: record.players.map((item, index) => validateRoomPlayerInfo(item, `payload.players[${index}]`)),
    };
}

function validatePlayerInputPayload(value: unknown): PlayerInputPayload {
    const record = readRecord(value, 'payload');
    return {
        acknowledgedTick: readNumber(record.acknowledgedTick, 'payload.acknowledgedTick'),
        input: validatePlayerInput(record.input, 'payload.input'),
    };
}

function validateCombatEventPayload(value: unknown): CombatEventPayload {
    const record = readRecord(value, 'payload');
    const eventType = readString(record.eventType, 'payload.eventType');

    assertCondition(
        eventType === 'missile_launch'
        || eventType === 'hit_result'
        || eventType === 'fighter_destroyed'
        || eventType === 'battle_status',
        'payload.eventType 必须是支持的战斗事件类型',
    );

    const battleStatusValue = record.battleStatus;
    assertCondition(
        battleStatusValue === null || battleStatusValue === 'playing' || battleStatusValue === 'defeat',
        'payload.battleStatus 必须是 playing、defeat 或 null',
    );
    const battleStatus = battleStatusValue as CombatEventPayload['battleStatus'];

    return {
        eventId: readString(record.eventId, 'payload.eventId'),
        eventType,
        actorPlayerId: readString(record.actorPlayerId, 'payload.actorPlayerId'),
        targetId: readNullableString(record.targetId, 'payload.targetId'),
        position: validateVector(record.position, 'payload.position'),
        battleStatus,
    };
}

function validateHeartbeatPayload(value: unknown): HeartbeatPayload {
    const record = readRecord(value, 'payload');
    return {
        pingMs: readNumber(record.pingMs, 'payload.pingMs'),
        serverTime: readNumber(record.serverTime, 'payload.serverTime'),
        acknowledgedTick: readNumber(record.acknowledgedTick, 'payload.acknowledgedTick'),
    };
}

function validateResyncRequestPayload(value: unknown): ResyncRequestPayload {
    const record = readRecord(value, 'payload');
    const reason = readString(record.reason, 'payload.reason');

    assertCondition(
        reason === 'snapshot_gap' || reason === 'state_divergence' || reason === 'reconnect',
        'payload.reason 必须是 snapshot_gap、state_divergence 或 reconnect',
    );

    return {
        requestedTick: readNumber(record.requestedTick, 'payload.requestedTick'),
        reason,
    };
}

function validateResyncStatePayload(value: unknown): ResyncStatePayload {
    const record = readRecord(value, 'payload');
    validateGameSnapshotShape(record.snapshot, 'payload.snapshot');
    assertCondition(Array.isArray(record.recentEvents), 'payload.recentEvents 必须是数组');

    return {
        fromTick: readNumber(record.fromTick, 'payload.fromTick'),
        toTick: readNumber(record.toTick, 'payload.toTick'),
        snapshot: record.snapshot as ResyncStatePayload['snapshot'],
        recentEvents: record.recentEvents.map((item) => validateCombatEventPayload(item)),
    };
}

function validatePayloadByType(type: NetMessageType, payload: unknown): unknown {
    const record = readRecord(payload, 'payload');

    switch (type) {
        case NetMessageType.MSG_FIGHTER_MOVE:
            return {
                fighterId: readString(record.fighterId, 'payload.fighterId'),
                position: validateVector(record.position, 'payload.position') as Vector2DData,
                heading: readNumber(record.heading, 'payload.heading'),
                speed: readNumber(record.speed, 'payload.speed'),
            };
        case NetMessageType.MSG_MISSILE_LAUNCH:
            return validateMissileLaunchPayload(record);
        case NetMessageType.MSG_HIT_RESULT:
            return {
                attackerId: readString(record.attackerId, 'payload.attackerId'),
                targetId: readString(record.targetId, 'payload.targetId'),
                damage: readNumber(record.damage, 'payload.damage'),
                destroyed: readBoolean(record.destroyed, 'payload.destroyed'),
            };
        case NetMessageType.MSG_BATTLE_STATUS: {
            const status = readString(record.status, 'payload.status');
            assertCondition(status === 'playing' || status === 'defeat', 'payload.status 必须是 playing 或 defeat');
            return {
                status,
                redRemaining: readNumber(record.redRemaining, 'payload.redRemaining'),
                blueRemaining: readNumber(record.blueRemaining, 'payload.blueRemaining'),
                score: readNumber(record.score, 'payload.score'),
            };
        }
        case NetMessageType.MSG_ROOM_JOIN: {
            const faction = readString(record.faction, 'payload.faction');
            assertCondition(faction === 'red' || faction === 'blue', 'payload.faction 必须是 red 或 blue');
            return {
                roomId: readString(record.roomId, 'payload.roomId'),
                playerId: readString(record.playerId, 'payload.playerId'),
                playerName: readString(record.playerName, 'payload.playerName'),
                faction,
            };
        }
        case NetMessageType.MSG_ROOM_STATE:
            return validateRoomStatePayload(record);
        case NetMessageType.MSG_PLAYER_READY:
            assertCondition(Array.isArray(record.readyPlayers), 'payload.readyPlayers 必须是数组');
            return {
                ready: readBoolean(record.ready, 'payload.ready'),
                readyPlayers: record.readyPlayers.map((item, index) => readString(item, `payload.readyPlayers[${index}]`)),
            };
        case NetMessageType.MSG_PLAYER_INPUT:
            return validatePlayerInputPayload(record);
        case NetMessageType.MSG_STATE_SNAPSHOT:
            validateGameSnapshotShape(record.state, 'payload.state');
            return {
                snapshotId: readString(record.snapshotId, 'payload.snapshotId'),
                serverTick: readNumber(record.serverTick, 'payload.serverTick'),
                lastProcessedInputSequence: readNumber(
                    record.lastProcessedInputSequence,
                    'payload.lastProcessedInputSequence',
                ),
                state: record.state,
            };
        case NetMessageType.MSG_COMBAT_EVENT:
            return validateCombatEventPayload(record);
        case NetMessageType.MSG_HEARTBEAT:
            return validateHeartbeatPayload(record);
        case NetMessageType.MSG_RESYNC_REQUEST:
            return validateResyncRequestPayload(record);
        case NetMessageType.MSG_RESYNC_STATE:
            return validateResyncStatePayload(record);
    }
}

/**
 * 统一校验网络消息的公共元数据和按类型分派的载荷结构，避免客户端与服务端各写一套隐式规则。
 */
export function validateNetworkMessage(message: unknown): NetworkMessage {
    const record = readRecord(message, 'message');
    const typeValue = record.type;

    assertCondition(isNetMessageType(typeValue), 'message.type 非法');
    const version = readNumber(record.version, 'message.version');
    assertCondition(version === SUPPORTED_PROTOCOL_VERSION, 'message.version 不受支持');

    if (record.errorCode !== undefined) {
        readString(record.errorCode, 'message.errorCode');
    }
    if (record.errorMessage !== undefined) {
        readString(record.errorMessage, 'message.errorMessage');
    }

    const validatedMessage: NetworkMessage = {
        type: typeValue,
        version: 1,
        roomId: readString(record.roomId, 'message.roomId'),
        playerId: readString(record.playerId, 'message.playerId'),
        tick: readNumber(record.tick, 'message.tick'),
        inputSequence: readNumber(record.inputSequence, 'message.inputSequence'),
        sentAt: readNumber(record.sentAt, 'message.sentAt'),
        payload: validatePayloadByType(typeValue, record.payload),
    } as NetworkMessage;

    if (record.errorCode !== undefined) {
        validatedMessage.errorCode = record.errorCode as NetworkMessage['errorCode'];
    }
    if (record.errorMessage !== undefined) {
        validatedMessage.errorMessage = record.errorMessage as NetworkMessage['errorMessage'];
    }

    return validatedMessage;
}

/**
 * 将强类型网络消息编码为 JSON 字符串，供客户端和服务端共享。
 */
export function encodeNetworkMessage(message: NetworkMessage): string {
    const validatedMessage = validateNetworkMessage(message);
    return JSON.stringify(validatedMessage);
}

/**
 * 从 JSON 字符串恢复网络消息，并在返回前完成结构校验。
 */
export function decodeNetworkMessage(payload: string): NetworkMessage {
    let parsed: unknown;

    try {
        parsed = JSON.parse(payload) as unknown;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '未知 JSON 解析错误';
        throw new Error(`网络消息不是合法 JSON: ${errorMessage}`);
    }

    return validateNetworkMessage(parsed);
}

/**
 * 仅提取消息类型，用于分发前的快速路由判断。
 */
export function getNetworkMessageType(payload: string): NetMessageType {
    const record = readRecord(JSON.parse(payload) as unknown, 'message');
    assertCondition(isNetMessageType(record.type), 'message.type 非法');
    return record.type;
}

/**
 * JSON 协议对象，控制层可直接复用而不再复制序列化细节。
 */
export class JsonNetworkProtocol implements INetworkProtocol {
    Serialize(message: NetworkMessage): string {
        return encodeNetworkMessage(message);
    }

    Deserialize(payload: string): NetworkMessage {
        return decodeNetworkMessage(payload);
    }

    GetMessageType(payload: string): NetMessageType {
        return getNetworkMessageType(payload);
    }

    Validate(message: unknown): NetworkMessage {
        return validateNetworkMessage(message);
    }
}
