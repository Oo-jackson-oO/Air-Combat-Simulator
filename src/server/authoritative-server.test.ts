import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { NetMessageType, type NetworkMessage, type RoomStateMessage, type StateSnapshotMessage } from '../game/interfaces.ts';
import { startAuthoritativeServer } from './index.ts';

function createServerConfig() {
    return {
        maxPlayersPerRoom: 2,
        tickDurationMs: 50,
        snapshotHistoryLimit: 8,
        simulationConfig: {
            tickDurationMs: 50,
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

function waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', (error) => reject(error));
    });
}

function waitForMessage<TMessage extends NetworkMessage>(
    socket: WebSocket,
    predicate: (message: NetworkMessage) => message is TMessage,
    deserialize: (payload: string) => NetworkMessage,
): Promise<TMessage> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('等待 WebSocket 消息超时'));
        }, 3000);

        const handleMessage = (data: WebSocket.RawData): void => {
            const message = deserialize(data.toString());
            if (!predicate(message)) {
                return;
            }

            cleanup();
            resolve(message);
        };

        const handleError = (error: Error): void => {
            cleanup();
            reject(error);
        };

        const cleanup = (): void => {
            clearTimeout(timeout);
            socket.off('message', handleMessage);
            socket.off('error', handleError);
        };

        socket.on('message', handleMessage);
        socket.on('error', handleError);
    });
}

async function testWebSocketTransportBridgesClientsToRoomServer(): Promise<void> {
    const server = startAuthoritativeServer(createServerConfig(), 0);
    const protocol = server.roomServer.getProtocol();
    const redSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const blueSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);

    try {
        await Promise.all([waitForOpen(redSocket), waitForOpen(blueSocket)]);

        const redRoomStatePromise = waitForMessage<RoomStateMessage>(
            redSocket,
            (message): message is RoomStateMessage => (
                message.type === NetMessageType.MSG_ROOM_STATE
                && message.payload.players.length === 2
            ),
            (payload) => protocol.Deserialize(payload),
        );
        const blueRoomStatePromise = waitForMessage<RoomStateMessage>(
            blueSocket,
            (message): message is RoomStateMessage => (
                message.type === NetMessageType.MSG_ROOM_STATE
                && message.payload.players.length === 2
            ),
            (payload) => protocol.Deserialize(payload),
        );

        redSocket.send(protocol.Serialize({
            type: NetMessageType.MSG_ROOM_JOIN,
            version: 1,
            roomId: 'room-alpha',
            playerId: 'player-red',
            tick: 0,
            inputSequence: 0,
            sentAt: Date.now(),
            payload: {
                roomId: 'room-alpha',
                playerId: 'player-red',
                playerName: '红方玩家',
                faction: 'red',
            },
        }));
        blueSocket.send(protocol.Serialize({
            type: NetMessageType.MSG_ROOM_JOIN,
            version: 1,
            roomId: 'room-alpha',
            playerId: 'player-blue',
            tick: 0,
            inputSequence: 0,
            sentAt: Date.now(),
            payload: {
                roomId: 'room-alpha',
                playerId: 'player-blue',
                playerName: '蓝方玩家',
                faction: 'blue',
            },
        }));

        const redRoomState = await redRoomStatePromise;
        const blueRoomState = await blueRoomStatePromise;

        assert.equal(redRoomState.payload.players.length, 2);
        assert.equal(blueRoomState.payload.players.length, 2);

        const snapshotPromise = waitForMessage<StateSnapshotMessage>(
            redSocket,
            (message): message is StateSnapshotMessage => message.type === NetMessageType.MSG_STATE_SNAPSHOT,
            (payload) => protocol.Deserialize(payload),
        );

        redSocket.send(protocol.Serialize({
            type: NetMessageType.MSG_PLAYER_READY,
            version: 1,
            roomId: 'room-alpha',
            playerId: 'player-red',
            tick: 0,
            inputSequence: 1,
            sentAt: Date.now(),
            payload: {
                ready: true,
                readyPlayers: ['player-red'],
            },
        }));
        blueSocket.send(protocol.Serialize({
            type: NetMessageType.MSG_PLAYER_READY,
            version: 1,
            roomId: 'room-alpha',
            playerId: 'player-blue',
            tick: 0,
            inputSequence: 1,
            sentAt: Date.now(),
            payload: {
                ready: true,
                readyPlayers: ['player-red', 'player-blue'],
            },
        }));

        const snapshot = await snapshotPromise;

        assert.ok(snapshot.payload.serverTick >= 1, '双方准备完成后，客户端应通过真实 WebSocket 收到权威快照');
    } finally {
        redSocket.close();
        blueSocket.close();
        await server.close();
    }
}

await testWebSocketTransportBridgesClientsToRoomServer();
console.log('authoritative-server tests passed');
