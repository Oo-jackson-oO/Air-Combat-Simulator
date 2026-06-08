import type { AuthoritativeSimulationConfig } from '../game/authoritative-simulation.ts';
import { JsonNetworkProtocol } from '../game/network-protocol.ts';
import {
    NetMessageType,
    type NetworkMessage,
    type PlayerInputMessage,
    type ResyncRequestMessage,
    type RoomJoinMessage,
} from '../game/interfaces.ts';
import { AuthoritativeRoom, type AuthoritativeRoomConfig } from './room.ts';
import type { ServerSession } from './session.ts';

export interface AuthoritativeRoomServerConfig {
    maxPlayersPerRoom: number;
    tickDurationMs: number;
    snapshotHistoryLimit: number;
    simulationConfig: AuthoritativeSimulationConfig;
}

/**
 * 服务端入口只负责协议路由与房间生命周期，让权威房间保持纯粹的战局编排职责。
 */
export class AuthoritativeRoomServer {
    private readonly config: AuthoritativeRoomServerConfig;

    private readonly protocol: JsonNetworkProtocol;

    private readonly rooms: Map<string, AuthoritativeRoom>;

    private readonly sessionBindings: Map<string, { roomId: string; playerId: string }>;

    constructor(config: AuthoritativeRoomServerConfig) {
        this.config = config;
        this.protocol = new JsonNetworkProtocol();
        this.rooms = new Map<string, AuthoritativeRoom>();
        this.sessionBindings = new Map<string, { roomId: string; playerId: string }>();
    }

    getProtocol(): JsonNetworkProtocol {
        return this.protocol;
    }

    getRoom(roomId: string): AuthoritativeRoom | undefined {
        return this.rooms.get(roomId);
    }

    listRooms(): Array<ReturnType<AuthoritativeRoom['getSummary']>> {
        return [...this.rooms.values()].map((room) => room.getSummary());
    }

    handleClientPayload(session: ServerSession, payload: string): void {
        const message = this.protocol.Deserialize(payload);
        this.handleClientMessage(session, message);
    }

    handleClientMessage(session: ServerSession, message: NetworkMessage): void {
        if (message.type === NetMessageType.MSG_ROOM_JOIN) {
            const room = this.getOrCreateRoom(message.roomId);
            room.join(session, message as RoomJoinMessage);
            this.sessionBindings.set(session.connectionId, {
                roomId: message.roomId,
                playerId: message.playerId,
            });
            return;
        }

        const room = this.rooms.get(message.roomId);

        if (!room) {
            throw new Error(`房间 ${message.roomId} 不存在，无法处理消息 ${message.type}`);
        }

        switch (message.type) {
            case NetMessageType.MSG_PLAYER_READY:
                room.setPlayerReady(message.playerId, message.payload.ready, message.tick, message.inputSequence);
                break;
            case NetMessageType.MSG_PLAYER_INPUT:
                room.enqueueInput(message as PlayerInputMessage);
                break;
            case NetMessageType.MSG_RESYNC_REQUEST:
                room.sendResync(message as ResyncRequestMessage);
                break;
            case NetMessageType.MSG_HEARTBEAT:
                break;
            default:
                throw new Error(`服务端暂不支持消息类型 ${message.type}`);
        }
    }

    disconnectSession(session: ServerSession, reason: string): void {
        const binding = this.sessionBindings.get(session.connectionId);

        if (!binding) {
            session.close(reason);
            return;
        }

        const room = this.rooms.get(binding.roomId);

        if (room) {
            room.leave(binding.playerId);

            if (room.isEmpty()) {
                room.stop();
                this.rooms.delete(binding.roomId);
            }
        }

        this.sessionBindings.delete(session.connectionId);
        session.close(reason);
    }

    stop(): void {
        for (const room of this.rooms.values()) {
            room.stop();
        }
    }

    private getOrCreateRoom(roomId: string): AuthoritativeRoom {
        const existingRoom = this.rooms.get(roomId);

        if (existingRoom) {
            return existingRoom;
        }

        const roomConfig: AuthoritativeRoomConfig = {
            roomId,
            maxPlayers: this.config.maxPlayersPerRoom,
            tickDurationMs: this.config.tickDurationMs,
            snapshotHistoryLimit: this.config.snapshotHistoryLimit,
            simulationConfig: this.config.simulationConfig,
        };
        const room = new AuthoritativeRoom(roomConfig);
        this.rooms.set(roomId, room);
        return room;
    }
}
