import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSelectedOngoingCallId } from './callSelection.ts';

interface TestCall {
  id: string;
  state: 'active' | 'incoming' | 'ended';
}

const isOngoing = (call: TestCall) => call.state !== 'ended';
const isIncoming = (call: TestCall) => call.state === 'incoming';

test('pickSelectedOngoingCallId drops a terminal selection in favor of an active call', () => {
  const calls: TestCall[] = [
    { id: 'ended', state: 'ended' },
    { id: 'active', state: 'active' },
  ];

  assert.equal(pickSelectedOngoingCallId('ended', calls, new Set(), isOngoing, isIncoming), 'active');
});

test('pickSelectedOngoingCallId prioritizes an unseen incoming call and preserves active selection otherwise', () => {
  const calls: TestCall[] = [
    { id: 'active', state: 'active' },
    { id: 'incoming', state: 'incoming' },
  ];

  assert.equal(pickSelectedOngoingCallId('active', calls, new Set(), isOngoing, isIncoming), 'incoming');
  assert.equal(pickSelectedOngoingCallId('active', calls, new Set(['incoming']), isOngoing, isIncoming), 'active');
  assert.equal(
    pickSelectedOngoingCallId(null, [{ id: 'ended', state: 'ended' }], new Set(), isOngoing, isIncoming),
    null,
  );
});
