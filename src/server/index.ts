import express from 'express';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { AuthoritativeRoomServer, type AuthoritativeRoomServerConfig } from './room-server.ts';
import { WebSocketServerSession } from './session.ts';

export function createAuthoritativeRoomServer(config: AuthoritativeRoomServerConfig): AuthoritativeRoomServer {
    return new AuthoritativeRoomServer(config);
}

/**
 * 独立服务端入口先暴露健康检查和房间概览，后续接入 WebSocket 时可直接复用同一个房间服务器实例。
 */
export function startAuthoritativeServer(config: AuthoritativeRoomServerConfig, port: number): {
    app: express.Express;
    roomServer: AuthoritativeRoomServer;
    port: number;
    close: () => Promise<void>;
} {
    const app = express();
    const roomServer = createAuthoritativeRoomServer(config);
    const httpServer = createServer(app);
    const wsServer = new WebSocketServer({
        server: httpServer,
        path: '/ws',
    });
    let connectionCounter = 0;

    app.get('/health', (_request, response) => {
        response.json({
            status: 'ok',
            rooms: roomServer.listRooms().length,
        });
    });

    app.get('/rooms', (_request, response) => {
        response.json({
            rooms: roomServer.listRooms(),
        });
    });

    wsServer.on('connection', (socket) => {
        connectionCounter += 1;
        const session = new WebSocketServerSession(`ws-${connectionCounter}`, socket);
        let disconnected = false;

        const disconnect = (reason: string): void => {
            if (disconnected) {
                return;
            }
            disconnected = true;
            roomServer.disconnectSession(session, reason);
        };

        socket.on('message', (data) => {
            try {
                roomServer.handleClientPayload(session, data.toString());
            } catch (error) {
                const reason = error instanceof Error ? error.message : '网络消息处理失败';
                disconnect(reason);
            }
        });

        socket.on('close', (code, reasonBuffer) => {
            const reason = reasonBuffer.toString() || `WebSocket 已关闭（code=${code}）`;
            disconnect(reason);
        });

        socket.on('error', (error) => {
            disconnect(error.message);
        });
    });

    httpServer.listen(port);
    const serverAddress = httpServer.address();
    if (!serverAddress || typeof serverAddress === 'string') {
        throw new Error('权威服务器启动失败：无法解析监听端口');
    }

    const close = async (): Promise<void> => {
        roomServer.stop();
        wsServer.clients.forEach((client) => {
            client.close(1000, '服务端关闭');
        });
        wsServer.close();

        await new Promise<void>((resolve, reject) => {
            httpServer.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    };

    return {
        app,
        roomServer,
        port: serverAddress.port,
        close,
    };
}

function buildStandaloneConfig(): AuthoritativeRoomServerConfig {
    return {
        maxPlayersPerRoom: 2,
        tickDurationMs: 100,
        snapshotHistoryLimit: 16,
        simulationConfig: {
            tickDurationMs: 100,
            mapWidth: 3000,
            mapHeight: 3000,
            radarRange: 1000,
            snapshotFps: 60,
            playerHp: 180,
            playerSpeed: 320,
            enemyHp: 120,
            enemySpeed: 240,
            missileDamage: 60,
            missileSpeed: 1200,
            missileLifetimeTicks: 12,
            weaponCooldownTicks: 3,
            aiFireCooldownTicks: 6,
            aiCount: 2,
        },
    };
}

const executedFilePath = process.argv[1];
const executedFileUrl = executedFilePath ? pathToFileURL(executedFilePath).href : null;

if (executedFileUrl === import.meta.url) {
    const port = 3210;
    const server = startAuthoritativeServer(buildStandaloneConfig(), port);

    console.log(`权威服务器已启动: http://localhost:${port}/health`);

    const shutdown = async (): Promise<void> => {
        await server.close();
        process.exit(0);
    };

    process.once('SIGINT', () => {
        void shutdown();
    });
    process.once('SIGTERM', () => {
        void shutdown();
    });
}
