/**
 * Explicit gateway lifecycle. The states are the deployment contract: health/readiness must
 * never infer a state from a socket object, and an invalid transition is a programming error.
 */

export const GATEWAY_STATES = [
    "STOPPED",
    "STARTING",
    "PAIRING_REQUIRED",
    "CONNECTED",
    "DISCONNECTED",
    "LOGGED_OUT",
    "CONFLICT",
    "ERROR",
] as const;

export type GatewayState = (typeof GATEWAY_STATES)[number];

const TRANSITIONS: Record<GatewayState, readonly GatewayState[]> = {
    STOPPED: ["STARTING"],
    STARTING: [
        "PAIRING_REQUIRED",
        "CONNECTED",
        "DISCONNECTED",
        "LOGGED_OUT",
        "CONFLICT",
        "ERROR",
        "STOPPED",
    ],
    PAIRING_REQUIRED: ["STARTING", "LOGGED_OUT", "CONFLICT", "ERROR", "STOPPED"],
    CONNECTED: ["DISCONNECTED", "LOGGED_OUT", "CONFLICT", "ERROR", "STOPPED"],
    DISCONNECTED: ["STARTING", "LOGGED_OUT", "CONFLICT", "ERROR", "STOPPED"],
    LOGGED_OUT: ["STARTING", "CONFLICT", "ERROR", "STOPPED"],
    CONFLICT: ["STOPPED"],
    ERROR: ["STOPPED"],
};

export type LifecycleListener = (next: GatewayState, previous: GatewayState) => void;

export class GatewayLifecycle {
    private current: GatewayState = "STOPPED";
    private changedAt = new Date();
    private reason: string | null = null;
    private readonly listeners = new Set<LifecycleListener>();

    get state(): GatewayState {
        return this.current;
    }

    get since(): Date {
        return this.changedAt;
    }

    get lastReason(): string | null {
        return this.reason;
    }

    canTransition(next: GatewayState): boolean {
        return TRANSITIONS[this.current].includes(next);
    }

    transition(next: GatewayState, reason: string | null = null): void {
        if (next === this.current) {
            return;
        }

        if (!this.canTransition(next)) {
            throw new Error(
                `Invalid WhatsApp gateway transition ${this.current} -> ${next}.`
            );
        }

        const previous = this.current;
        this.current = next;
        this.changedAt = new Date();
        this.reason = reason;

        for (const listener of this.listeners) {
            listener(next, previous);
        }
    }

    onChange(listener: LifecycleListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }
}
