import {
    AuthoritativeBattleSimulation,
    type AuthoritativeSimulationConfig,
    type AuthoritativeSimulationStepResult,
    type QueuedSimulationInput,
} from '../game/authoritative-simulation.ts';
import { JsonNetworkProtocol } from '../game/network-protocol.ts';
import {
    NetMessageType,
    type NetworkMessage,
    type PlayerInputMessage,
    type ResyncRequestMessage,
    type RoomJoinMessage,
    type RoomPhase,
    type RoomPlayerInfo,
    type RoomStatePayload,
} from '../game/interfaces.ts';
import type { ServerSession } from './session.ts';

interface PendingRoomInput {
    playerId: string;
    inputSequence: number;
    input: PlayerInputMessage['payload']['input'];
}

interface TickHistoryEntry {
    tick: number;
    snapshot: AuthoritativeSimulationStepResult['snapshot'];
    events: AuthoritativeSimulationStepResult['events'];
    lastProcessedInputSequence: number;
}

export interface AuthoritativeRoomConfig {
    roomId: string;
    maxPlayers: number;
    tickDurationMs: number;
    snapshotHistoryLimit: number;
    simulationConfig: AuthoritativeSimulationConfig;
}

/**
 * 房间对象负责把会话层输入整理成固定节拍的权威战场推进，避免服务端入口直接操作模型细节。
 */
export class AuthoritativeRoom {
    private readonly config: AuthoritativeRoomConfig;

    private readonly protocol: JsonNetworkProtocol;

    private readonly simulation: AuthoritativeBattleSimulation;

    private readonly players: Map<string, RoomPlayerInfo>;

    private readonly sessions: Map<string, ServerSession>;

    private readonly pendingInputs: Map<number, Map<string, PendingRoomInput>>;

    private readonly history: TickHistoryEntry[];

    private phase: RoomPhase;

    private hostPlayerId: string | null;

    private tickTimer: ReturnType<typeof setInterval> | null;

    constructor(config: AuthoritativeRoomConfig) {
        this.config = config;
        this.protocol = new JsonNetworkProtocol();
        this.simulation = new AuthoritativeBattleSimulation(config.simulationConfig);
        this.players = new Map<string, RoomPlayerInfo>();
        this.sessions = new Map<string, ServerSession>();
        this.pendingInputs = new Map<number, Map<string, PendingRoomInput>>();
        this.history = [];
        this.phase = 'waiting';
        this.hostPlayerId = null;
        this.tickTimer = null;
    }

    getRoomId(): string {
        return this.config.roomId;
    }

    getPhase(): RoomPhase {
        return this.phase;
    }

    getCurrentTick(): number {
        return this.simulation.getCurrentTick();
    }

    getPlayerCount(): number {
        return this.players.size;
    }

    isEmpty(): boolean {
        return this.players.size === 0;
    }

    getSummary(): RoomStatePayload & { currentTick: number } {
        return {
            ...this.buildRoomStatePayload(),
            currentTick: this.getCurrentTick(),
        };
    }

    join(session: ServerSession, message: RoomJoinMessage): void {
        if (this.players.size >= this.config.maxPlayers) {
            throw new Error(`房间 ${this.config.roomId} 已满，拒绝玩家 ${message.playerId} 加入`);
        }

        if (this.players.has(message.playerId)) {
            throw new Error(`玩家 ${message.playerId} 已在房间 ${this.config.roomId} 中`);
        }

        const playerInfo: RoomPlayerInfo = {
            playerId: message.payload.playerId,
            playerName: message.payload.playerName,
            faction: message.payload.faction,
            ready: false,
        };

        this.players.set(message.playerId, playerInfo);
        this.sessions.set(message.playerId, session);

        if (!this.hostPlayerId) {
            this.hostPlayerId = message.playerId;
        }

        this.refreshWaitingPhase();
        this.broadcastRoomState();
    }

    leave(playerId: string): void {
        this.players.delete(playerId);
        this.sessions.delete(playerId);
        this.pendingInputs.forEach((inputsByPlayer) => inputsByPlayer.delete(playerId));

        if (this.hostPlayerId === playerId) {
            const nextHost = this.players.values().next();
            this.hostPlayerId = nextHost.done ? null : nextHost.value.playerId;
        }

        if (this.players.size === 0) {
            this.stop();
            this.phase = 'waiting';
            return;
        }

        if (this.phase === 'running') {
            this.stop();
            this.phase = 'finished';
        } else {
            this.refreshWaitingPhase();
        }

        this.broadcastRoomState();
    }

    setPlayerReady(playerId: string, ready: boolean, sourceTick: number, sourceSequence: number): void {
        const player = this.players.get(playerId);

        if (!player) {
            throw new Error(`玩家 ${playerId} 不在房间 ${this.config.roomId} 中`);
        }

        player.ready = ready;
        this.broadcastMessage({
            type: NetMessageType.MSG_PLAYER_READY,
            version: 1,
            roomId: this.config.roomId,
            playerId,
            tick: sourceTick,
            inputSequence: sourceSequence,
            sentAt: Date.now(),
            payload: {
                ready,
                readyPlayers: [...this.players.values()]
                    .filter((roomPlayer) => roomPlayer.ready)
                    .map((roomPlayer) => roomPlayer.playerId),
            },
        });

        if (this.players.size >= 2 && [...this.players.values()].every((roomPlayer) => roomPlayer.ready)) {
            this.startBattle();
            return;
        }

        this.refreshWaitingPhase();
        this.broadcastRoomState();
    }

    enqueueInput(message: PlayerInputMessage): void {
        if (this.phase !== 'running') {
            throw new Error(`房间 ${this.config.roomId} 尚未开局，不能接收玩家输入`);
        }

        if (!this.players.has(message.playerId)) {
            throw new Error(`玩家 ${message.playerId} 不在房间 ${this.config.roomId} 中`);
        }

        if (message.tick <= this.getCurrentTick()) {
            throw new Error(`玩家 ${message.playerId} 的输入节拍 ${message.tick} 已过期`);
        }

        const inputsByPlayer = this.pendingInputs.get(message.tick) ?? new Map<string, PendingRoomInput>();
        const existingInput = inputsByPlayer.get(message.playerId);

        if (!existingInput || existingInput.inputSequence < message.inputSequence) {
            inputsByPlayer.set(message.playerId, {
                playerId: message.playerId,
                inputSequence: message.inputSequence,
                input: message.payload.input,
            });
        }

        this.pendingInputs.set(message.tick, inputsByPlayer);
    }

    runTick(): void {
        if (this.phase !== 'running') {
            return;
        }

        const nextTick = this.getCurrentTick() + 1;
        const queuedInputs = this.pendingInputs.get(nextTick);
        const simulationInputs: QueuedSimulationInput[] = queuedInputs
            ? [...queuedInputs.values()].map((input) => ({
                playerId: input.playerId,
                inputSequence: input.inputSequence,
                input: input.input,
            }))
            : [];

        this.pendingInputs.delete(nextTick);

        const stepResult = this.simulation.step(simulationInputs);
        this.cacheTick(stepResult);
        this.broadcastSnapshot(stepResult);
        this.broadcastEvents(stepResult);

        if (stepResult.battleFinished) {
            this.stop();
            this.phase = 'finished';
            this.broadcastRoomState();
        }
    }

    sendResync(message: ResyncRequestMessage): void {
        const session = this.sessions.get(message.playerId);

        if (!session) {
            throw new Error(`重同步失败：玩家 ${message.playerId} 在房间 ${this.config.roomId} 中没有有效会话`);
        }

        if (this.history.length === 0) {
            throw new Error(`重同步失败：房间 ${this.config.roomId} 尚未产生权威快照`);
        }

        const requestedHistory = this.history.find((entry) => entry.tick >= message.payload.requestedTick) ?? this.history[0];
        const latestHistory = this.history[this.history.length - 1];
        const recentEvents = this.history
            .filter((entry) => entry.tick >= requestedHistory.tick)
            .flatMap((entry) => entry.events);

        this.sendToPlayer(message.playerId, {
            type: NetMessageType.MSG_RESYNC_STATE,
            version: 1,
            roomId: this.config.roomId,
            playerId: 'server',
            tick: latestHistory.tick,
            inputSequence: latestHistory.lastProcessedInputSequence,
            sentAt: Date.now(),
            payload: {
                fromTick: requestedHistory.tick,
                toTick: latestHistory.tick,
                snapshot: latestHistory.snapshot,
                recentEvents,
            },
        });
    }

    stop(): void {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    private startBattle(): void {
        this.stop();
        this.phase = 'running';
        this.pendingInputs.clear();
        this.history.length = 0;
        this.simulation.reset([...this.players.values()]);
        this.broadcastRoomState();
        this.tickTimer = setInterval(() => {
            this.runTick();
        }, this.config.tickDurationMs);
    }

    private refreshWaitingPhase(): void {
        const readyPlayers = [...this.players.values()].filter((player) => player.ready);
        this.phase = readyPlayers.length > 0 ? 'ready' : 'waiting';
    }

    private cacheTick(stepResult: AuthoritativeSimulationStepResult): void {
        this.history.push({
            tick: stepResult.serverTick,
            snapshot: stepResult.snapshot,
            events: stepResult.events,
            lastProcessedInputSequence: stepResult.lastProcessedInputSequence,
        });

        while (this.history.length > this.config.snapshotHistoryLimit) {
            this.history.shift();
        }
    }

    private broadcastSnapshot(stepResult: AuthoritativeSimulationStepResult): void {
        this.broadcastMessage({
            type: NetMessageType.MSG_STATE_SNAPSHOT,
            version: 1,
            roomId: this.config.roomId,
            playerId: 'server',
            tick: stepResult.serverTick,
            inputSequence: stepResult.lastProcessedInputSequence,
            sentAt: Date.now(),
            payload: {
                snapshotId: `${this.config.roomId}-${stepResult.serverTick}`,
                serverTick: stepResult.serverTick,
                lastProcessedInputSequence: stepResult.lastProcessedInputSequence,
                state: stepResult.snapshot,
            },
        });
    }

    private broadcastEvents(stepResult: AuthoritativeSimulationStepResult): void {
        for (const event of stepResult.events) {
            this.broadcastMessage({
                type: NetMessageType.MSG_COMBAT_EVENT,
                version: 1,
                roomId: this.config.roomId,
                playerId: event.actorPlayerId,
                tick: stepResult.serverTick,
                inputSequence: stepResult.lastProcessedInputSequence,
                sentAt: Date.now(),
                payload: event,
            });
        }
    }

    private buildRoomStatePayload(): RoomStatePayload {
        const roomPlayers = [...this.players.values()];
        const hostPlayerId = this.hostPlayerId ?? roomPlayers[0]?.playerId ?? 'server';

        return {
            roomId: this.config.roomId,
            phase: this.phase,
            hostPlayerId,
            maxPlayers: this.config.maxPlayers,
            players: roomPlayers,
        };
    }

    private broadcastRoomState(): void {
        this.broadcastMessage({
            type: NetMessageType.MSG_ROOM_STATE,
            version: 1,
            roomId: this.config.roomId,
            playerId: 'server',
            tick: this.getCurrentTick(),
            inputSequence: 0,
            sentAt: Date.now(),
            payload: this.buildRoomStatePayload(),
        });
    }

    private broadcastMessage(message: NetworkMessage): void {
        const payload = this.protocol.Serialize(message);

        for (const session of this.sessions.values()) {
            session.send(payload);
        }
    }

    private sendToPlayer(playerId: string, message: NetworkMessage): void {
        const session = this.sessions.get(playerId);

        if (!session) {
            throw new Error(`玩家 ${playerId} 在房间 ${this.config.roomId} 中没有有效会话`);
        }

        session.send(this.protocol.Serialize(message));
    }
}
