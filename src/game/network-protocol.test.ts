import assert from 'node:assert/strict';

import {
    NetMessageType,
    type NetworkMessage,
} from './interfaces.ts';
import { JsonNetworkProtocol } from './network-protocol.ts';

function createRoomJoinMessage(): NetworkMessage {
    return {
        type: NetMessageType.MSG_ROOM_JOIN,
        version: 1,
        roomId: 'room-alpha',
        playerId: 'player-red',
        tick: 12,
        inputSequence: 0,
        sentAt: 1710000000000,
        payload: {
            roomId: 'room-alpha',
            playerId: 'player-red',
            playerName: '测试玩家',
            faction: 'red',
        },
    };
}

function testRoundTrip() {
    const protocol = new JsonNetworkProtocol();
    const message = createRoomJoinMessage();
    const encoded = protocol.Serialize(message);
    const decoded = protocol.Deserialize(encoded);

    assert.equal(protocol.GetMessageType(encoded), NetMessageType.MSG_ROOM_JOIN);
    assert.deepEqual(decoded, message);
}

function testRejectsMissingVersion() {
    const protocol = new JsonNetworkProtocol();
    const invalidPayload = JSON.stringify({
        type: NetMessageType.MSG_HEARTBEAT,
        roomId: 'room-alpha',
        playerId: 'player-red',
        tick: 18,
        inputSequence: 2,
        sentAt: 1710000000100,
        payload: {
            pingMs: 45,
            serverTime: 1710000000100,
        },
    });

    assert.throws(() => {
        protocol.Deserialize(invalidPayload);
    }, /version/i);
}

testRoundTrip();
testRejectsMissingVersion();
console.log('network-protocol tests passed');
