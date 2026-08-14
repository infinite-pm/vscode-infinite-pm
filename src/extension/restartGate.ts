// The two pieces of timing that guard a server restart.
//
// Both used to be module-level `let`s in index.ts — a boolean and a timer
// handle — which made them untestable without an extension host and, worse,
// invisible: nothing said what they were for except the code that set them.
//
// They exist for one failure each:
//
//   * A second restart arriving while the first is mid-flight would stop a
//     client that is already stopping and start a second server. The gate
//     turns that into a logged skip.
//   * `go install ./cmd/ipm-rpc` does not write one event. It writes a
//     tempfile and renames it over the target, and some platforms report that
//     as several. Restarting per event means restarting a server that is still
//     being replaced, so the trailing edge is what matters, not the leading.

/** How long the binary must be quiet before a restart is worth attempting. */
export const BINARY_SETTLE_MS = 500;

export interface RestartGate {
    /** Claim the right to restart. False means one is already running. */
    tryEnter(): boolean;
    /** Release it. Always call this — a leaked gate wedges restarts forever. */
    leave(): void;
    /** For tests and diagnostics. */
    readonly busy: boolean;
}

export function createRestartGate(): RestartGate {
    let inFlight = false;
    return {
        tryEnter() {
            if (inFlight) return false;
            inFlight = true;
            return true;
        },
        leave() { inFlight = false; },
        get busy() { return inFlight; },
    };
}

export interface Settler {
    /** Note an event; the action fires once the noise stops. */
    bump(): void;
    /** Drop a pending action — the watcher is going away. */
    cancel(): void;
    readonly pending: boolean;
}

/**
 * Trailing-edge debounce. `setTimer`/`clearTimer` are injectable so tests need
 * no wall-clock; production passes Node's.
 */
export function createSettler(
    action: () => void,
    delayMs: number = BINARY_SETTLE_MS,
    setTimer: (fn: () => void, ms: number) => NodeJS.Timeout = setTimeout,
    clearTimer: (t: NodeJS.Timeout) => void = clearTimeout,
): Settler {
    let timer: NodeJS.Timeout | undefined;
    return {
        bump() {
            if (timer) clearTimer(timer);
            timer = setTimer(() => { timer = undefined; action(); }, delayMs);
        },
        cancel() {
            if (timer) clearTimer(timer);
            timer = undefined;
        },
        get pending() { return timer !== undefined; },
    };
}
