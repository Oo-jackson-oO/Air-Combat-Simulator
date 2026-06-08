import WebSocket from 'ws';

import type { INetworkProtocol, NetworkMessage } from '../game/interfaces.ts';

export interface ServerSession {
    connectionId: string;
    send(payload: string): void;
    close(reason: string): void;
}

/**
 * 内存会话用于隔离房间调度和真实传输层，方便后续替换成 WebSocket 并保持单元测试稳定。
 */
export class MemoryServerSession implements ServerSession {
    readonly connectionId: string;

    private readonly payloads: string[];

    private closedReason: string | null;

    constructor(connectionId: string) {
        this.connectionId = connectionId;
        this.payloads = [];
        this.closedReason = null;
    }

    send(payload: string): void {
        this.payloads.push(payload);
    }

    close(reason: string): void {
        this.closedReason = reason;
    }

    readPayloads(): string[] {
        return [...this.payloads];
    }

    readMessages(protocol: INetworkProtocol): NetworkMessage[] {
        return this.payloads.map((payload) => protocol.Deserialize(payload));
    }

    readClosedReason(): string | null {
        return this.closedReason;
    }
}

/**
 * WebSocket 会话适配器只负责把底层连接包装成房间服务器可复用的 `ServerSession`，避免网络传输细节渗入房间逻辑。
 */
export class WebSocketServerSession implements ServerSession {
    readonly connectionId: string;

    private readonly socket: WebSocket;

    constructor(connectionId: string, socket: WebSocket) {
        this.connectionId = connectionId;
        this.socket = socket;
    }

    send(payload: string): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(payload);
        }
    }

    close(reason: string): void {
        if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
            this.socket.close(1000, reason);
        }
    }
}
