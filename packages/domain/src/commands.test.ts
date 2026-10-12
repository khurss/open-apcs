import { describe, expect, it } from 'vitest';
import { CommandBook, type CommandRequest, type CommandContext } from './commands.js';

function fixture() {
  let now = 0;
  let wall = Date.parse('2026-10-12T12:00:00Z');
  const book = new CommandBook({ monotonicNow: () => now, wallNow: () => new Date(wall) });
  const request: CommandRequest = {
    id: 'cmd-1', idempotencyKey: 'key-1', actorId: 'operator', targetSignalId: 'led',
    value: true, ttlMs: 3_000, expectedProjectRevision: 1, reason: 'LED commissioning',
  };
  const context: CommandContext = {
    bootId: 'boot-1', projectRevision: 1, quality: 'Good', interlockReason: null,
    ownerId: 'operator', maxTtlMs: 3_000,
  };
  return { book, request, context,
    advance: (ms: number) => { now += ms; wall += ms; },
    shiftWall: (ms: number) => { wall += ms; },
  };
}

describe('AT-03: command lifecycle for boolean outputs', () => {
  it('restores a trusted journal snapshot without replaying a dispatch', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    const snapshot = book.dispatch(request.id, context)!;
    const restored = CommandBook.restore(
      { monotonicNow: () => 50, wallNow: () => new Date('2026-10-12T12:00:01Z') },
      request, snapshot, 2_000,
    );
    expect(restored.dispatch(request.id, context)).toBeNull();
    expect(restored.get(request.id).history).toEqual(snapshot.history);
    expect(restored.acknowledge({ id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied', value: true })).toBe(true);
    expect(snapshot.state).toBe('Dispatched');
  });

  it('restoration never resets an elapsed deadline', () => {
    const { book, request, context } = fixture();
    const snapshot = book.request(request, context);
    const restored = CommandBook.restore(
      { monotonicNow: () => 0, wallNow: () => new Date() }, request, snapshot, -1,
    );
    expect(restored.get(request.id).state).toBe('Expired');
  });

  it('rejects nonfinite remaining time and inconsistent restored identity', () => {
    const { book, request, context } = fixture();
    const snapshot = book.request(request, context);
    const clock = { monotonicNow: () => 0, wallNow: () => new Date() };
    expect(() => CommandBook.restore(clock, request, snapshot, Infinity)).toThrow(/remaining|deadline/i);
    expect(() => CommandBook.restore(clock, request, { ...snapshot, value: false }, 1_000)).toThrow(/snapshot/i);
  });

  it('records a request without claiming that the output was changed', () => {
    const { book, request, context } = fixture();
    const command = book.request(request, context);
    expect(command.state).toBe('Accepted');
    expect(command.evidence).toBeNull();
    expect(command.history.map((event) => event.state)).toEqual(['Requested', 'Accepted']);
  });

  it.each([
    { interlockReason: 'Emergency interlock active' },
    { quality: 'Stale' as const },
    { bootId: null },
    { projectRevision: 2 },
    { ownerId: 'auto-graph' },
    { maxTtlMs: 100 },
  ])('rejects unsafe requests and explains the reason: %j', (override) => {
    const { book, request, context } = fixture();
    const command = book.request(request, { ...context, ...override });
    expect(command.state).toBe('Rejected');
    expect(command.reason).toBeTruthy();
    expect(book.dispatch(request.id, context)).toBeNull();
  });

  it('rechecks interlocks immediately before dispatch, even for the manual owner', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    expect(book.dispatch(request.id, { ...context, interlockReason: 'Tank empty' })).toBeNull();
    expect(book.get(request.id)).toMatchObject({ state: 'Rejected', reason: 'Tank empty' });
  });

  it.each([{ bootId: 'boot-2' }, { projectRevision: 2 }, { ownerId: 'auto' }, { quality: 'Bad' as const }])(
    'does not dispatch after context changes: %j', (override) => {
      const { book, request, context } = fixture();
      book.request(request, context);
      expect(book.dispatch(request.id, { ...context, ...override })).toBeNull();
      expect(book.get(request.id).state).toBe('Rejected');
    },
  );

  it('deduplicates the same payload regardless of object property order or generated ID', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as unknown as CommandRequest;
    const duplicate = book.request({ ...reordered, id: 'unused-id' }, context);
    expect(duplicate.id).toBe(request.id);
    expect(() => book.request({ ...request, value: false }, context)).toThrow(/conflict/i);
    expect(book.get(request.id).value).toBe(true);
  });

  it('scopes idempotency to the authenticated actor and rejects ID collisions', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    expect(() => book.request({ ...request, idempotencyKey: 'different' }, context)).toThrow(/id|conflict/i);
    expect(book.request({ ...request, id: 'other', actorId: 'engineer' }, {
      ...context, ownerId: 'engineer',
    }).id).toBe('other');
  });

  it('expires at the deadline using monotonic time despite a wall-clock jump', () => {
    const { book, request, context, advance, shiftWall } = fixture();
    book.request(request, context);
    shiftWall(-60_000);
    advance(3_000);
    expect(book.dispatch(request.id, context)).toBeNull();
    expect(book.get(request.id).state).toBe('Expired');
  });

  it('dispatches at most once; application acceptance is not verified execution', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    expect(book.dispatch(request.id, context)?.state).toBe('Dispatched');
    expect(book.dispatch(request.id, context)).toBeNull();
    expect(book.acknowledge({ id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'accepted' })).toBe(true);
    expect(book.get(request.id)).toMatchObject({ state: 'DeviceAccepted', evidence: null });
    expect(book.acknowledge({ id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied', value: true })).toBe(true);
    expect(book.get(request.id)).toMatchObject({ state: 'Verified', evidence: 'firmware-reported-output' });
  });

  it('rejects ACK before dispatch, mismatched device/session/value and duplicate ACK', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    const ack = { id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied' as const, value: true };
    expect(book.acknowledge(ack)).toBe(false);
    book.dispatch(request.id, context);
    expect(book.acknowledge({ ...ack, bootId: 'old-boot' })).toBe(false);
    expect(book.acknowledge({ ...ack, targetSignalId: 'other' })).toBe(false);
    expect(book.acknowledge({ ...ack, value: false })).toBe(false);
    expect(book.acknowledge(ack)).toBe(true);
    expect(book.acknowledge(ack)).toBe(false);
  });

  it('a lost ACK produces Unknown and never an automatic retry', () => {
    const { book, request, context, advance } = fixture();
    book.request(request, context);
    book.dispatch(request.id, context);
    advance(3_000);
    expect(book.get(request.id).state).toBe('Unknown');
    expect(book.dispatch(request.id, context)).toBeNull();
    expect(book.acknowledge({ id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'applied', value: true })).toBe(false);
    expect(book.request(request, context).state).toBe('Unknown');
  });

  it('a lost connection cancels unsent commands and leaves sent results Unknown', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    book.request({ ...request, id: 'cmd-2', idempotencyKey: 'key-2' }, context);
    book.dispatch(request.id, context);
    book.connectionLost('led');
    expect(book.get(request.id).state).toBe('Unknown');
    expect(book.get('cmd-2').state).toBe('Cancelled');
    expect(book.dispatch('cmd-2', context)).toBeNull();
  });

  it('records explicit device failure separately from a timeout', () => {
    const { book, request, context } = fixture();
    book.request(request, context);
    book.dispatch(request.id, context);
    book.acknowledge({ id: request.id, targetSignalId: 'led', bootId: 'boot-1', status: 'failed', reason: 'Watchdog active' });
    expect(book.get(request.id)).toMatchObject({ state: 'Failed', reason: 'Watchdog active' });
  });

  it('returns independent history and ignores subsequent caller mutations', () => {
    const { book, request, context } = fixture();
    const command = book.request(request, context);
    request.value = false;
    command.history[0]!.state = 'Verified';
    command.history.length = 0;
    expect(book.get(request.id).history.map((event) => event.state)).toEqual(['Requested', 'Accepted']);
    expect(book.get(request.id).value).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects malformed TTL %s before recording a request', (ttlMs) => {
    const { book, request, context } = fixture();
    expect(() => book.request({ ...request, ttlMs }, context)).toThrow(/ttl/i);
    expect(() => book.get(request.id)).toThrow(/unknown/i);
  });
});
