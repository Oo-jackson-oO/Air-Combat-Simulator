import assert from 'node:assert/strict';

import type { AuthoritativeRoomServerConfig } from './room-server.ts';
import { AuthoritativeRoomServer } from './room-server.ts';
import { MemoryServerSession } from './session.ts';
import {
    NetMessageType,
    type CombatEventMessage,
    type NetworkMessage,
    type ResyncStateMessage,
    type RoomStateMessage,
    type StateSnapshotMessage,
} from '../game/interfaces.ts';

function createServerConfig(): AuthoritativeRoomServerConfig {
    return {
        maxPlayersPerRoom: 2,
        tickDurationMs: 100,
        snapshotHistoryLimit: 6,
        simulationConfig: {
            tickDurationMs: 100,
            mapWidth: 3000,
            mapHeight: 3000,
            radarRange: 1000,
            snapshotFps: 60,
            playerHp: 180,
            playerSpeed: 320,
            enemyHp: 120,
            enemySpeed: 220,
            missileDamage: 60,
            missileSpeed: 1800,
            missileLifetimeTicks: 16,
            weaponCooldownTicks: 3,
            aiFireCooldownTicks: 7,
            aiCount: 1,
        },
    };
}

function createMessage(message: NetworkMessage): NetworkMessage {
    return message;
}

function filterMessagesByType<TMessage extends NetworkMessage>(
    messages: NetworkMessage[],
    type: TMessage['type'],
): TMessage[] {
    return messages.filter((message) => message.type === type) as TMessage[];
}

function testAuthoritativeRoomServerFlow(): void {
    const server = new AuthoritativeRoomServer(createServerConfig());
    const redSession = new MemoryServerSession('conn-red');
    const blueSession = new MemoryServerSession('conn-blue');

    server.handleClientMessage(redSession, createMessage({
        type: NetMessageType.MSG_ROOM_JOIN,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-red',
        tick: 0,
        inputSequence: 0,
        sentAt: 1,
        payload: {
            roomId: 'room-alpha',
            playerId: 'player-red',
            playerName: '红方玩家',
            faction: 'red',
        },
    }));
    server.handleClientMessage(blueSession, createMessage({
        type: NetMessageType.MSG_ROOM_JOIN,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-blue',
        tick: 0,
        inputSequence: 0,
        sentAt: 2,
        payload: {
            roomId: 'room-alpha',
            playerId: 'player-blue',
            playerName: '蓝方玩家',
            faction: 'blue',
        },
    }));

    const room = server.getRoom('room-alpha');
    assert.ok(room, '加入房间后应创建对应房间');
    assert.equal(server.listRooms().length, 1);

    server.handleClientMessage(redSession, createMessage({
        type: NetMessageType.MSG_PLAYER_READY,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-red',
        tick: 0,
        inputSequence: 1,
        sentAt: 3,
        payload: {
            ready: true,
            readyPlayers: ['player-red'],
        },
    }));
    server.handleClientMessage(blueSession, createMessage({
        type: NetMessageType.MSG_PLAYER_READY,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-blue',
        tick: 0,
        inputSequence: 1,
        sentAt: 4,
        payload: {
            ready: true,
            readyPlayers: ['player-red', 'player-blue'],
        },
    }));

    assert.equal(room?.getPhase(), 'running');
    room?.stop();

    for (const targetTick of [1, 4, 7]) {
        server.handleClientMessage(redSession, createMessage({
            type: NetMessageType.MSG_PLAYER_INPUT,
            version: 1,
            roomId: 'room-alpha',
            playerId: 'player-red',
            tick: targetTick,
            inputSequence: targetTick,
            sentAt: 10 + targetTick,
            payload: {
                acknowledgedTick: targetTick - 1,
                input: {
                    throttle: 'hold',
                    turn: 'hold',
                    fireMissile: true,
                    fireBomb: false,
                    targetId: 'player-blue',
                    aimHeading: 0,
                },
            },
        }));
    }

    for (let currentTick = 1; currentTick <= 14; currentTick += 1) {
        room?.runTick();
    }

    const redMessages = redSession.readMessages(server.getProtocol());
    const blueMessages = blueSession.readMessages(server.getProtocol());
    const snapshots = filterMessagesByType<StateSnapshotMessage>(redMessages, NetMessageType.MSG_STATE_SNAPSHOT);
    const combatEvents = filterMessagesByType<CombatEventMessage>(redMessages, NetMessageType.MSG_COMBAT_EVENT);

    assert.ok(snapshots.length >= 6, '运行多个节拍后应持续广播权威快照');
    assert.ok(
        combatEvents.some((message) => message.payload.eventType === 'missile_launch'),
        '发射输入被消费后应广播导弹发射事件',
    );
    assert.ok(
        combatEvents.some((message) => message.payload.eventType === 'fighter_destroyed'),
        '多次命中后应广播击毁事件',
    );
    assert.ok(
        blueMessages.some((message) => message.type === NetMessageType.MSG_STATE_SNAPSHOT),
        '房间内所有玩家都应收到相同的权威快照广播',
    );

    server.handleClientMessage(redSession, createMessage({
        type: NetMessageType.MSG_RESYNC_REQUEST,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-red',
        tick: room?.getCurrentTick() ?? 0,
        inputSequence: 99,
        sentAt: 99,
        payload: {
            requestedTick: 1,
            reason: 'snapshot_gap',
        },
    }));

    const latestMessages = redSession.readMessages(server.getProtocol());
    const resyncMessages = filterMessagesByType<ResyncStateMessage>(latestMessages, NetMessageType.MSG_RESYNC_STATE);
    const latestResync = resyncMessages[resyncMessages.length - 1];

    assert.ok(latestResync, '请求重同步后应返回最近节拍缓存');
    assert.ok(latestResync.payload.fromTick > 1, '历史缓存达到上限后应丢弃过旧节拍');
    assert.equal(latestResync.payload.toTick, room?.getCurrentTick());
    assert.ok(latestResync.payload.recentEvents.length > 0, '重同步响应应附带最近战斗事件');

    server.disconnectSession(blueSession, '测试断开');

    const latestRoomStates = filterMessagesByType<RoomStateMessage>(
        redSession.readMessages(server.getProtocol()),
        NetMessageType.MSG_ROOM_STATE,
    );
    const latestRoomState = latestRoomStates[latestRoomStates.length - 1];

    assert.equal(blueSession.readClosedReason(), '测试断开');
    assert.equal(latestRoomState.payload.players.length, 1, '玩家离开后房间状态应同步减少成员');

    server.stop();
}

testAuthoritativeRoomServerFlow();
console.log('room-server tests passed');
