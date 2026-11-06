/**
 * Bounded reconnect policy. It is deliberately pure so the backoff contract can be tested
 * without timers, sockets or a real WhatsApp connection.
 */
export type ReconnectPlan = {
    attempt: number;
    delayMs: number;
};

export class ReconnectPolicy {
    private attempt = 0;

    constructor(private readonly delaysMs: readonly number[]) {}

    next(): ReconnectPlan | null {
        const delayMs = this.delaysMs[this.attempt];

        if (delayMs === undefined) {
            return null;
        }

        this.attempt += 1;

        return { attempt: this.attempt, delayMs };
    }

    reset(): void {
        this.attempt = 0;
    }

    get attempts(): number {
        return this.attempt;
    }
}
