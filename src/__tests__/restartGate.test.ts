// The timing around a server restart: a gate so two restarts cannot overlap,
// and a settler so a binary being replaced does not cause one restart per
// filesystem event.
//
// Both were module-level `let`s in index.ts until now, which is why neither had
// a test — and why `go install ./cmd/ipm-rpc` racing the watcher was something
// we reasoned about rather than something we asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BINARY_SETTLE_MS, createRestartGate, createSettler } from '../extension/restartGate';

// --- the gate -----------------------------------------------------------

test('the second restart is refused while the first is in flight', () => {
    const gate = createRestartGate();
    assert.equal(gate.tryEnter(), true, 'the first caller restarts');
    assert.equal(gate.tryEnter(), false, 'a restart during a restart stops one server twice');
    assert.equal(gate.tryEnter(), false);
    assert.equal(gate.busy, true);
});

test('leaving lets the next one in', () => {
    const gate = createRestartGate();
    gate.tryEnter();
    gate.leave();
    assert.equal(gate.busy, false);
    assert.equal(gate.tryEnter(), true, 'a released gate must not stay shut');
});

test('leaving without entering does not open a hole', () => {
    // restartClient releases in a finally; a double release must not let two
    // callers in at once.
    const gate = createRestartGate();
    gate.leave();
    assert.equal(gate.tryEnter(), true);
    assert.equal(gate.tryEnter(), false, 'still exactly one restart at a time');
});

// --- the settler --------------------------------------------------------

/** A fake clock: timers fire only when the test says so. */
function fakeTimers() {
    const scheduled = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
        set: (fn: () => void, ms: number) => {
            const id = next++;
            scheduled.set(id, { fn, ms });
            return id as unknown as NodeJS.Timeout;
        },
        clear: (t: NodeJS.Timeout) => { scheduled.delete(t as unknown as number); },
        /** Fire everything still scheduled, in order. */
        run: () => {
            for (const [id, entry] of [...scheduled]) {
                scheduled.delete(id);
                entry.fn();
            }
        },
        get live() { return scheduled.size; },
        get delays() { return [...scheduled.values()].map((e) => e.ms); },
    };
}

test('a burst of events produces exactly one restart', () => {
    // `go install` writes a tempfile and renames it over the target; some
    // platforms report that as several events. One restart, after the noise.
    const clock = fakeTimers();
    let restarts = 0;
    const settler = createSettler(() => { restarts++; }, BINARY_SETTLE_MS, clock.set, clock.clear);

    settler.bump();
    settler.bump();
    settler.bump();
    assert.equal(restarts, 0, 'nothing fires while the binary is still being written');
    assert.equal(clock.live, 1, 'each event must cancel the timer before it');

    clock.run();
    assert.equal(restarts, 1);
    assert.equal(settler.pending, false);
});

test('a later change starts a fresh window rather than being swallowed', () => {
    const clock = fakeTimers();
    let restarts = 0;
    const settler = createSettler(() => { restarts++; }, BINARY_SETTLE_MS, clock.set, clock.clear);

    settler.bump();
    clock.run();
    settler.bump();
    clock.run();
    assert.equal(restarts, 2, 'a second rebuild deserves a second restart');
});

test('cancelling drops a pending restart', () => {
    // stopBinaryWatcher runs when the client is going away; a restart firing
    // after that would start a server nobody asked for.
    const clock = fakeTimers();
    let restarts = 0;
    const settler = createSettler(() => { restarts++; }, BINARY_SETTLE_MS, clock.set, clock.clear);

    settler.bump();
    assert.equal(settler.pending, true);
    settler.cancel();
    assert.equal(settler.pending, false);

    clock.run();
    assert.equal(restarts, 0, 'a cancelled settler must not fire');
});

test('the settle window is long enough to cover a rename, short enough to feel instant', () => {
    const clock = fakeTimers();
    const settler = createSettler(() => { /* noop */ }, BINARY_SETTLE_MS, clock.set, clock.clear);
    settler.bump();
    assert.deepEqual(clock.delays, [BINARY_SETTLE_MS]);
    assert.ok(BINARY_SETTLE_MS >= 200 && BINARY_SETTLE_MS <= 1000,
        'below ~200ms a rename can still be in progress; above a second the ' +
        'developer notices the lag after rebuilding');
});
