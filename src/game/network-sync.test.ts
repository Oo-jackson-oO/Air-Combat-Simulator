import assert from 'node:assert/strict';

import type { FighterSnapshot, ResyncStateMessage, StateSnapshotMessage } from './interfaces.ts';
import { NetMessageType } from './interfaces.ts';
import {
    ClientSyncTracker,
    interpolateFighterCorrection,
} from './network-sync.ts';

function createStateSnapshotMessage(serverTick: number, inputSequence: number): StateSnapshotMessage {
    return {
        type: NetMessageType.MSG_STATE_SNAPSHOT,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'server',
        tick: serverTick,
        inputSequence,
        sentAt: 1710000000000 + serverTick,
        payload: {
            snapshotId: `room-alpha-${serverTick}`,
            serverTick,
            lastProcessedInputSequence: inputSequence,
            state: {
                fps: 60,
                player: {
                    id: 'player-red',
                    isPlayer: true,
                    isBoss: false,
                    type: '歼-20',
                    x: serverTick * 10,
                    y: 100,
                    heading: 0,
                    hp: 100,
                    maxHp: 100,
                    speed: 320,
                    inRadarRange: true,
                    dashCooldown: 0,
                    isDashing: false,
                },
                enemies: [],
                missiles: [],
                lasers: [],
                mapBounds: { width: 3000, height: 3000 },
                status: 'playing',
                radarRange: 1000,
                score: 0,
                timeScale: 1,
                cinematicFocus: null,
                bossSpawning: false,
                bossIndicatorTime: 0,
            },
        },
    };
}

function createResyncMessage(fromTick: number, toTick: number, inputSequence: number): ResyncStateMessage {
    return {
        type: NetMessageType.MSG_RESYNC_STATE,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'server',
        tick: toTick,
        inputSequence,
        sentAt: 1710000001000 + toTick,
        payload: {
            fromTick,
            toTick,
            snapshot: createStateSnapshotMessage(toTick, inputSequence).payload.state,
            recentEvents: [],
        },
    };
}

function createFighter(x: number, y: number, heading: number): FighterSnapshot {
    return {
        id: 'player-red',
        isPlayer: true,
        isBoss: false,
        type: '歼-20',
        x,
        y,
        heading,
        hp: 100,
        maxHp: 100,
        speed: 320,
        inRadarRange: true,
        dashCooldown: 0,
        isDashing: false,
    };
}

function testRejectsOutdatedAndDuplicateSnapshots(): void {
    const tracker = new ClientSyncTracker({
        snapshotGapThreshold: 2,
        divergenceDistanceThreshold: 40,
        divergenceResyncThreshold: 220,
    });

    const first = tracker.acceptStateSnapshot(createStateSnapshotMessage(3, 3));
    assert.equal(first.status, 'accepted');
    assert.equal(first.shouldRequestResync, false);

    const duplicate = tracker.acceptStateSnapshot(createStateSnapshotMessage(3, 3));
    assert.equal(duplicate.status, 'duplicate');

    const expired = tracker.acceptStateSnapshot(createStateSnapshotMessage(2, 2));
    assert.equal(expired.status, 'expired');

    const gapped = tracker.acceptStateSnapshot(createStateSnapshotMessage(6, 5));
    assert.equal(gapped.status, 'accepted');
    assert.equal(gapped.shouldRequestResync, true);
    assert.equal(gapped.requestedTick, 4);
    assert.equal(gapped.reason, 'snapshot_gap');
}

function testResyncClearsGapStateAndDivergenceProducesCorrection(): void {
    const tracker = new ClientSyncTracker({
        snapshotGapThreshold: 2,
        divergenceDistanceThreshold: 40,
        divergenceResyncThreshold: 220,
    });

    tracker.acceptStateSnapshot(createStateSnapshotMessage(1, 1));
    tracker.acceptStateSnapshot(createStateSnapshotMessage(4, 2));

    const resync = tracker.acceptResyncState(createResyncMessage(2, 4, 2));
    assert.equal(resync.status, 'accepted');

    const afterResync = tracker.acceptStateSnapshot(createStateSnapshotMessage(5, 2));
    assert.equal(afterResync.status, 'accepted');
    assert.equal(afterResync.shouldRequestResync, false);

    const smoothCorrection = tracker.evaluateDivergence(createFighter(0, 0, 0), createFighter(120, 0, 0.4));
    assert.equal(smoothCorrection.action, 'smooth_correct');

    const hardResync = tracker.evaluateDivergence(createFighter(0, 0, 0), createFighter(400, 0, 0.4));
    assert.equal(hardResync.action, 'request_resync');

    const interpolated = interpolateFighterCorrection(createFighter(0, 0, 0), createFighter(100, 50, 1), 0.5);
    assert.equal(interpolated.x, 50);
    assert.equal(interpolated.y, 25);
    assert.ok(interpolated.heading > 0 && interpolated.heading < 1);
}

testRejectsOutdatedAndDuplicateSnapshots();
testResyncClearsGapStateAndDivergenceProducesCorrection();
console.log('network-sync tests passed');
