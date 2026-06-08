import {
    type CombatEventPayload,
    type CombatEventMessage,
    type HeartbeatPayload,
    type HeartbeatMessage,
    type INetworkProtocol,
    type NetworkFaction,
    type NetworkHudSnapshot,
    type NetworkMessage,
    type NetworkPlayerInput,
    type ResyncReason,
    type ResyncStateMessage,
    type ResyncStatePayload,
    NetMessageType,
    type RoomPhase,
    type RoomPlayerInfo,
    type RoomStateMessage,
    type StateSnapshotMessage,
    type StateSnapshotPayload,
} from './interfaces.ts';
import { ClientSyncTracker } from './network-sync.ts';

const HEARTBEAT_INTERVAL_MS = 3000;
const SNAPSHOT_STALE_MS = 6000;
const RESYNC_REQUEST_COOLDOWN_MS = 1500;

type ClientEnv = ImportMeta & {
    env: Record<string, string | undefined>;
};

export interface BrowserNetworkJoinConfig {
    roomId: string;
    playerId: string;
    playerName: string;
    faction: NetworkFaction;
    wsUrl: string;
}

export interface NetworkBattleSessionConfig extends BrowserNetworkJoinConfig {
    protocol: INetworkProtocol;
}

type StateListener = (snapshot: NetworkHudSnapshot) => void;
type SnapshotListener = (payload: StateSnapshotPayload) => void;
type CombatEventListener = (payload: CombatEventPayload) => void;

function assertNonEmptyString(value: string | null, fieldName: string): string {
    if (!value || value.trim().length === 0) {
        throw new Error(`${fieldName} 缺失，请通过查询参数显式提供`);
    }
    return value.trim();
}

function assertFaction(value: string | null): NetworkFaction {
    if (value === 'red' || value === 'blue') {
        return value;
    }
    throw new Error('查询参数 faction 缺失或非法，只允许 red 或 blue');
}

/**
 * 从浏览器环境解析联网必需配置，缺失任一关键字段时立即抛错，避免客户端在未知房间上下文中静默运行。
 */
export function readBrowserNetworkJoinConfig(): BrowserNetworkJoinConfig {
    const env = (import.meta as ClientEnv).env;
    const wsUrl = env.VITE_NETWORK_BATTLE_WS_URL;
    if (!wsUrl || wsUrl.trim().length === 0) {
        throw new Error('缺少环境变量 VITE_NETWORK_BATTLE_WS_URL，请先配置联机服务地址');
    }

    const searchParams = new URLSearchParams(window.location.search);
    const roomId = assertNonEmptyString(searchParams.get('roomId'), '查询参数 roomId');
    const playerName = assertNonEmptyString(searchParams.get('playerName'), '查询参数 playerName');
    const faction = assertFaction(searchParams.get('faction'));

    return {
        roomId,
        playerId: crypto.randomUUID(),
        playerName,
        faction,
        wsUrl: wsUrl.trim(),
    };
}

function createInitialHudSnapshot(config: BrowserNetworkJoinConfig): NetworkHudSnapshot {
    return {
        connectionState: 'idle',
        syncState: 'joining',
        roomId: config.roomId,
        roomPhase: null,
        localPlayerId: config.playerId,
        localPlayerName: config.playerName,
        localFaction: config.faction,
        remotePlayers: [],
        pingMs: null,
        lastServerTick: null,
        lastProcessedInputSequence: 0,
        lastHeartbeatAt: null,
        disconnectReason: null,
        errorMessage: null,
    };
}

/**
 * 负责客户端与权威服务器之间的会话生命周期，控制层只通过它收发网络消息和读取联机状态。
 */
export class NetworkBattleSession {
    private readonly stateListeners = new Set<StateListener>();
    private readonly snapshotListeners = new Set<SnapshotListener>();
    private readonly combatEventListeners = new Set<CombatEventListener>();
    private readonly config: NetworkBattleSessionConfig;
    private socket: WebSocket | null = null;
    private heartbeatTimerId: number | null = null;
    private state: NetworkHudSnapshot;
    private lastSnapshotAt: number | null = null;
    private lastHeartbeatSentAt: number | null = null;
    private readySent = false;
    private lastResyncRequestAt: number | null = null;
    private readonly syncTracker: ClientSyncTracker;

    constructor(config: NetworkBattleSessionConfig) {
        this.config = config;
        this.state = createInitialHudSnapshot(config);
        this.syncTracker = new ClientSyncTracker({
            snapshotGapThreshold: 2,
            divergenceDistanceThreshold: 40,
            divergenceResyncThreshold: 240,
        });
    }

    /**
     * 建立 WebSocket 会话并在连接建立后立即发起房间加入，若底层握手失败则显式记录到状态中。
     */
    connect(): void {
        this.disposeSocket();
        this.syncTracker.reset();
        this.lastSnapshotAt = null;
        this.lastHeartbeatSentAt = null;
        this.lastResyncRequestAt = null;
        this.updateState({
            connectionState: 'connecting',
            syncState: 'joining',
            disconnectReason: null,
            errorMessage: null,
        });

        try {
            this.socket = new WebSocket(this.config.wsUrl);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'WebSocket 初始化失败';
            this.updateState({
                connectionState: 'error',
                syncState: 'disconnected',
                errorMessage: message,
                disconnectReason: message,
            });
            throw new Error(`无法连接联机服务: ${message}`);
        }

        this.socket.addEventListener('open', this.handleOpen);
        this.socket.addEventListener('message', this.handleMessage);
        this.socket.addEventListener('error', this.handleError);
        this.socket.addEventListener('close', this.handleClose);
    }

    /**
     * 关闭当前会话，确保心跳定时器和底层连接一并释放，避免页面卸载后继续占用网络资源。
     */
    disconnect(reason: string): void {
        this.stopHeartbeat();
        if (this.socket) {
            this.socket.removeEventListener('open', this.handleOpen);
            this.socket.removeEventListener('message', this.handleMessage);
            this.socket.removeEventListener('error', this.handleError);
            this.socket.removeEventListener('close', this.handleClose);
            if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
                this.socket.close(1000, reason);
            }
        }
        this.socket = null;
        this.updateState({
            connectionState: 'disconnected',
            syncState: 'disconnected',
            disconnectReason: reason,
        });
    }

    /**
     * 供控制层读取当前联机 HUD 状态，返回副本以避免外部意外改写会话内部状态。
     */
    getState(): NetworkHudSnapshot {
        return {
            ...this.state,
            remotePlayers: [...this.state.remotePlayers],
        };
    }

    subscribe(listener: StateListener): () => void {
        this.stateListeners.add(listener);
        listener(this.getState());
        return () => {
            this.stateListeners.delete(listener);
        };
    }

    onSnapshot(listener: SnapshotListener): () => void {
        this.snapshotListeners.add(listener);
        return () => {
            this.snapshotListeners.delete(listener);
        };
    }

    onCombatEvent(listener: CombatEventListener): () => void {
        this.combatEventListeners.add(listener);
        return () => {
            this.combatEventListeners.delete(listener);
        };
    }

    /**
     * 上传玩家输入并携带客户端已确认的服务端节拍，用于让权威服务器按顺序消费输入。
     */
    sendPlayerInput(input: NetworkPlayerInput, scheduledTick: number, acknowledgedTick: number, inputSequence: number): void {
        this.sendMessage({
            type: NetMessageType.MSG_PLAYER_INPUT,
            version: 1,
            roomId: this.config.roomId,
            playerId: this.config.playerId,
            tick: scheduledTick,
            inputSequence,
            sentAt: Date.now(),
            payload: {
                acknowledgedTick,
                input,
            },
        });
    }

    /**
     * 当控制层检测到预测态与权威态严重偏离时，显式请求服务端下发全量状态，避免继续在错误本地状态上渲染。
     */
    requestResync(reason: ResyncReason): void {
        const lastKnownTick = this.syncTracker.getLastSnapshotTick();
        const requestedTick = Math.max(1, lastKnownTick);
        this.sendResyncRequest(reason, requestedTick);
    }

    private handleOpen = (): void => {
        this.readySent = false;
        this.updateState({
            connectionState: 'connected',
            syncState: 'joining',
            disconnectReason: null,
            errorMessage: null,
        });
        this.sendRoomJoin();
        this.startHeartbeat();
    };

    private handleMessage = (event: MessageEvent<string>): void => {
        try {
            const message = this.config.protocol.Deserialize(event.data);
            this.routeMessage(message);
        } catch (error) {
            const message = error instanceof Error ? error.message : '收到无法解析的网络消息';
            this.updateState({
                connectionState: 'error',
                syncState: 'disconnected',
                errorMessage: message,
                disconnectReason: '网络消息解析失败',
            });
        }
    };

    private handleError = (): void => {
        this.updateState({
            connectionState: 'error',
            syncState: 'disconnected',
            errorMessage: '联机连接发生错误，请检查服务端日志',
        });
    };

    private handleClose = (event: CloseEvent): void => {
        this.stopHeartbeat();
        const reason = event.reason || `连接已关闭（code=${event.code}）`;
        this.socket = null;
        this.updateState({
            connectionState: 'disconnected',
            syncState: 'disconnected',
            disconnectReason: reason,
        });
    };

    private routeMessage(message: NetworkMessage): void {
        this.markInboundMessage(message.sentAt);
        switch (message.type) {
            case NetMessageType.MSG_ROOM_STATE:
                this.consumeRoomState(message as RoomStateMessage);
                return;
            case NetMessageType.MSG_STATE_SNAPSHOT:
                this.consumeStateSnapshot(message as StateSnapshotMessage);
                return;
            case NetMessageType.MSG_HEARTBEAT:
                this.consumeHeartbeat(message as HeartbeatMessage);
                return;
            case NetMessageType.MSG_COMBAT_EVENT:
                this.consumeCombatEvent(message as CombatEventMessage);
                return;
            case NetMessageType.MSG_RESYNC_STATE:
                this.consumeResyncState(message as ResyncStateMessage);
                return;
            default:
                return;
        }
    }

    private consumeRoomState(message: RoomStateMessage): void {
        const roomStateAcceptance = this.syncTracker.acceptRoomState(message.tick);
        if (roomStateAcceptance.status !== 'accepted') {
            return;
        }

        const serverTick = message.tick;
        const roomPhase = message.payload.phase;
        const players = message.payload.players;
        const remotePlayers = players.filter((player) => player.playerId !== this.config.playerId);
        const syncState = roomPhase === 'running'
            ? (this.lastSnapshotAt === null ? 'syncing' : 'live')
            : 'waiting_room';

        this.updateState({
            roomPhase,
            remotePlayers,
            syncState,
            lastServerTick: serverTick,
        });

        const localPlayer = players.find((player) => player.playerId === this.config.playerId);
        if (localPlayer && !localPlayer.ready && !this.readySent) {
            this.sendReady(serverTick);
        }
    }

    private consumeStateSnapshot(message: StateSnapshotMessage): void {
        const snapshotAcceptance = this.syncTracker.acceptStateSnapshot(message);
        if (snapshotAcceptance.status !== 'accepted') {
            return;
        }

        const payload = message.payload;
        this.lastSnapshotAt = Date.now();
        this.updateState({
            lastServerTick: payload.serverTick,
            lastProcessedInputSequence: payload.lastProcessedInputSequence,
            syncState: 'live',
        });
        this.snapshotListeners.forEach((listener) => {
            listener(payload);
        });

        if (snapshotAcceptance.shouldRequestResync && snapshotAcceptance.requestedTick !== null && snapshotAcceptance.reason) {
            this.sendResyncRequest(snapshotAcceptance.reason, snapshotAcceptance.requestedTick);
        }
    }

    private consumeResyncState(message: ResyncStateMessage): void {
        const resyncAcceptance = this.syncTracker.acceptResyncState(message);
        if (resyncAcceptance.status !== 'accepted') {
            return;
        }

        const payload = message.payload;
        this.lastSnapshotAt = Date.now();
        this.updateState({
            lastServerTick: payload.toTick,
            lastProcessedInputSequence: message.inputSequence,
            syncState: 'live',
        });
        this.snapshotListeners.forEach((listener) => {
            listener({
                snapshotId: `${this.config.roomId}-resync-${payload.toTick}`,
                serverTick: payload.toTick,
                lastProcessedInputSequence: message.inputSequence,
                state: payload.snapshot,
            });
        });
        this.combatEventListeners.forEach((listener) => {
            payload.recentEvents.forEach((event) => listener(event));
        });
    }

    private consumeHeartbeat(message: HeartbeatMessage): void {
        const heartbeatAcceptance = this.syncTracker.acceptHeartbeat(message.payload.acknowledgedTick);
        if (heartbeatAcceptance.status !== 'accepted') {
            return;
        }

        const payload = message.payload;
        const measuredPing = this.lastHeartbeatSentAt === null ? payload.pingMs : Date.now() - this.lastHeartbeatSentAt;
        this.updateState({
            pingMs: measuredPing,
            lastHeartbeatAt: Date.now(),
            lastServerTick: payload.acknowledgedTick,
        });
    }

    private consumeCombatEvent(message: CombatEventMessage): void {
        const combatEventAcceptance = this.syncTracker.acceptCombatEvent(message);
        if (combatEventAcceptance.status !== 'accepted') {
            return;
        }

        this.combatEventListeners.forEach((listener) => {
            listener(message.payload);
        });
    }

    private sendReady(serverTick: number): void {
        this.readySent = true;
        this.sendMessage({
            type: NetMessageType.MSG_PLAYER_READY,
            version: 1,
            roomId: this.config.roomId,
            playerId: this.config.playerId,
            tick: serverTick,
            inputSequence: 0,
            sentAt: Date.now(),
            payload: {
                ready: true,
                readyPlayers: [this.config.playerId],
            },
        });
    }

    private sendRoomJoin(): void {
        this.sendMessage({
            type: NetMessageType.MSG_ROOM_JOIN,
            version: 1,
            roomId: this.config.roomId,
            playerId: this.config.playerId,
            tick: 0,
            inputSequence: 0,
            sentAt: Date.now(),
            payload: {
                roomId: this.config.roomId,
                playerId: this.config.playerId,
                playerName: this.config.playerName,
                faction: this.config.faction,
            },
        });
    }

    private sendHeartbeat(): void {
        this.lastHeartbeatSentAt = Date.now();
        this.sendMessage({
            type: NetMessageType.MSG_HEARTBEAT,
            version: 1,
            roomId: this.config.roomId,
            playerId: this.config.playerId,
            tick: this.state.lastServerTick ?? 0,
            inputSequence: this.state.lastProcessedInputSequence,
            sentAt: this.lastHeartbeatSentAt,
            payload: {
                pingMs: 0,
                serverTime: this.lastHeartbeatSentAt,
                acknowledgedTick: this.state.lastServerTick ?? 0,
            },
        });
    }

    private sendMessage(message: NetworkMessage): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }

        this.socket.send(this.config.protocol.Serialize(message));
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimerId = window.setInterval(() => {
            this.refreshSyncState();
            this.sendHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimerId !== null) {
            window.clearInterval(this.heartbeatTimerId);
            this.heartbeatTimerId = null;
        }
    }

    private refreshSyncState(): void {
        if (this.state.connectionState !== 'connected') {
            return;
        }

        if (this.lastSnapshotAt !== null && Date.now() - this.lastSnapshotAt > SNAPSHOT_STALE_MS) {
            this.updateState({
                syncState: 'syncing',
                disconnectReason: '长时间未收到权威快照，正在请求重同步',
            });
            this.sendResyncRequest('snapshot_gap', Math.max(1, this.syncTracker.getLastSnapshotTick()));
        }
    }

    private markInboundMessage(serverSentAt: number): void {
        const transportLatency = Math.max(0, Date.now() - serverSentAt);
        this.updateState({
            pingMs: transportLatency,
            lastHeartbeatAt: Date.now(),
        });
    }

    private updateState(patch: Partial<NetworkHudSnapshot>): void {
        this.state = {
            ...this.state,
            ...patch,
            remotePlayers: patch.remotePlayers ? [...patch.remotePlayers] : this.state.remotePlayers,
        };
        const snapshot = this.getState();
        this.stateListeners.forEach((listener) => {
            listener(snapshot);
        });
    }

    private sendResyncRequest(reason: ResyncReason, requestedTick: number): void {
        const now = Date.now();
        if (this.lastResyncRequestAt !== null && now - this.lastResyncRequestAt < RESYNC_REQUEST_COOLDOWN_MS) {
            return;
        }

        this.lastResyncRequestAt = now;
        this.updateState({
            syncState: 'syncing',
        });
        this.sendMessage({
            type: NetMessageType.MSG_RESYNC_REQUEST,
            version: 1,
            roomId: this.config.roomId,
            playerId: this.config.playerId,
            tick: this.state.lastServerTick ?? 0,
            inputSequence: this.state.lastProcessedInputSequence,
            sentAt: now,
            payload: {
                requestedTick,
                reason,
            },
        });
    }

    private disposeSocket(): void {
        this.stopHeartbeat();
        if (!this.socket) {
            return;
        }

        this.socket.removeEventListener('open', this.handleOpen);
        this.socket.removeEventListener('message', this.handleMessage);
        this.socket.removeEventListener('error', this.handleError);
        this.socket.removeEventListener('close', this.handleClose);
        if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
            this.socket.close();
        }
        this.socket = null;
    }
}
