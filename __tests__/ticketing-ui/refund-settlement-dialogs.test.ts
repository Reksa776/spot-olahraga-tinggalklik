import fs from "fs";
import path from "path";

import {
    MANUAL_TRANSFER_DIALOGS,
    MIN_MANUAL_TRANSFER_LENGTH,
    getManualTransferDefinition,
    initialManualTransferState,
    isManualTransferInputValid,
    manualTransferBody,
    manualTransferFieldError,
    manualTransferReducer,
    type ManualTransferAction,
    type ManualTransferDialogKind,
    type ManualTransferEffect,
    type ManualTransferInput,
    type ManualTransferState,
} from "@/components/dashboard/manual-transfer-dialog";

/**
 * ==========================================
 * PHASE 20B — REFUND / SETTLEMENT DIALOGS
 * ==========================================
 *
 * The refund and settlement action components no longer chain `window.prompt` calls. Two
 * halves are asserted here:
 *
 *   1. THE MACHINE (pure, no DOM). `components/dashboard/manual-transfer-dialog.ts` owns
 *      which fields each dialog needs, what "valid" means, the exact JSON body the API
 *      receives, and the lifecycle that makes a double click harmless. The cases below pin
 *      the semantics the old prompts had, so the replacement is provably not a behaviour
 *      change: same 3-character minimum, same trimming, same optional-note omission, same
 *      field names the server schemas declare.
 *
 *   2. THE WIRING (static). The components must import the machine and the dashboard
 *      `Dialog`, must contain no native prompt/confirm/alert, and must keep posting to the
 *      same routes. A future edit that reintroduces `window.prompt` fails here.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so a comment DESCRIBING a banned pattern is not mistaken for it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const REFUND_ACTIONS = "components/dashboard/RefundDecisionActions.tsx";
const SETTLEMENT_ACTIONS = "components/dashboard/SettlementActions.tsx";
const MACHINE = "components/dashboard/manual-transfer-dialog.ts";
const HOOK = "components/dashboard/use-manual-transfer-dialog.ts";

function run(
    state: ManualTransferState,
    action: ManualTransferAction
): { state: ManualTransferState; effects: ManualTransferEffect[] } {
    return manualTransferReducer(state, action);
}

function starts(effects: ManualTransferEffect[]): Extract<ManualTransferEffect, { type: "start" }>[] {
    return effects.filter(
        (effect): effect is Extract<ManualTransferEffect, { type: "start" }> =>
            effect.type === "start"
    );
}

/** Open a dialog and type the given values, the way an operator would. */
function opened(
    kind: ManualTransferDialogKind,
    input: ManualTransferInput = {}
): ManualTransferState {
    let state = run(initialManualTransferState, { type: "open", kind }).state;

    for (const [field, value] of Object.entries(input) as [
        "reference" | "note" | "reason",
        string,
    ][]) {
        state = run(state, { type: "change", field, value }).state;
    }

    return state;
}

describe("Phase 20B — manual-transfer dialog definitions", () => {
    it("asks for exactly the fields each API schema requires", () => {
        expect(MANUAL_TRANSFER_DIALOGS.reject.fields).toEqual(["reason"]);
        expect(MANUAL_TRANSFER_DIALOGS.reject.required).toEqual(["reason"]);
        expect(MANUAL_TRANSFER_DIALOGS.settle.fields).toEqual(["reference", "note"]);
        expect(MANUAL_TRANSFER_DIALOGS.settle.required).toEqual(["reference"]);
        expect(MANUAL_TRANSFER_DIALOGS.fail.fields).toEqual(["reason"]);
        expect(MANUAL_TRANSFER_DIALOGS.fail.required).toEqual(["reason"]);
        expect(MANUAL_TRANSFER_DIALOGS.paid.fields).toEqual(["reference", "note"]);
        expect(MANUAL_TRANSFER_DIALOGS.paid.required).toEqual(["reference"]);
        expect(MANUAL_TRANSFER_DIALOGS.settleFail.fields).toEqual(["reason"]);
        expect(MANUAL_TRANSFER_DIALOGS.settleFail.required).toEqual(["reason"]);
    });

    it("posts to the action each component's button means", () => {
        expect(MANUAL_TRANSFER_DIALOGS.reject.action).toBe("reject");
        expect(MANUAL_TRANSFER_DIALOGS.settle.action).toBe("settle");
        expect(MANUAL_TRANSFER_DIALOGS.fail.action).toBe("fail");
        expect(MANUAL_TRANSFER_DIALOGS.paid.action).toBe("paid");
        expect(MANUAL_TRANSFER_DIALOGS.settleFail.action).toBe("fail");
    });

    it("caps every field at the maximum its server schema declares", () => {
        expect(MANUAL_TRANSFER_DIALOGS.reject.maxLengths.reason).toBe(1000);
        expect(MANUAL_TRANSFER_DIALOGS.fail.maxLengths.reason).toBe(1000);
        expect(MANUAL_TRANSFER_DIALOGS.settleFail.maxLengths.reason).toBe(500);
        expect(MANUAL_TRANSFER_DIALOGS.settle.maxLengths.reference).toBe(120);
        expect(MANUAL_TRANSFER_DIALOGS.paid.maxLengths.reference).toBe(120);
        expect(MANUAL_TRANSFER_DIALOGS.settle.maxLengths.note).toBe(1000);
        expect(MANUAL_TRANSFER_DIALOGS.paid.maxLengths.note).toBe(2000);
    });

    it("confirms the irreversible decisions with a destructive button", () => {
        for (const kind of Object.keys(MANUAL_TRANSFER_DIALOGS) as ManualTransferDialogKind[]) {
            expect(MANUAL_TRANSFER_DIALOGS[kind].destructive).toBe(true);
            expect(MANUAL_TRANSFER_DIALOGS[kind].confirmLabel.length).toBeGreaterThan(0);
            expect(MANUAL_TRANSFER_DIALOGS[kind].title.length).toBeGreaterThan(0);
            expect(MANUAL_TRANSFER_DIALOGS[kind].description.length).toBeGreaterThan(0);
        }
    });

    it("returns the definition for each kind unchanged", () => {
        for (const kind of Object.keys(MANUAL_TRANSFER_DIALOGS) as ManualTransferDialogKind[]) {
            expect(getManualTransferDefinition(kind)).toBe(MANUAL_TRANSFER_DIALOGS[kind]);
        }
    });
});

describe("Phase 20B — manual-transfer validation", () => {
    it("keeps the 3-character minimum every schema carries", () => {
        expect(MIN_MANUAL_TRANSFER_LENGTH).toBe(3);

        const settle = MANUAL_TRANSFER_DIALOGS.settle;

        expect(isManualTransferInputValid(settle, {})).toBe(false);
        expect(isManualTransferInputValid(settle, { reference: "ab" })).toBe(false);
        expect(isManualTransferInputValid(settle, { reference: "   ab   " })).toBe(false);
        expect(isManualTransferInputValid(settle, { reference: "abc" })).toBe(true);
        expect(isManualTransferInputValid(settle, { reference: "  abc  " })).toBe(true);
    });

    it("rejects a 1–2 character optional note but omits it from the body", () => {
        const settle = MANUAL_TRANSFER_DIALOGS.settle;
        const input = { reference: "TRX-1", note: "ab" };

        expect(manualTransferFieldError(settle, input)).toBe(
            settle.errors.note
        );
        expect(manualTransferBody(settle, input)).toEqual({ transferRef: "TRX-1" });
    });

    it("accepts an empty optional note", () => {
        const settle = MANUAL_TRANSFER_DIALOGS.settle;

        expect(isManualTransferInputValid(settle, { reference: "TRX-1" })).toBe(true);
        expect(isManualTransferInputValid(settle, { reference: "TRX-1", note: "" })).toBe(
            true
        );
        expect(isManualTransferInputValid(settle, { reference: "TRX-1", note: "  " })).toBe(
            true
        );
    });

    it("names the first invalid field, in the order the dialog shows them", () => {
        const settle = MANUAL_TRANSFER_DIALOGS.settle;
        const input: ManualTransferInput = { reason: "alasan cukup panjang" };

        expect(manualTransferFieldError(settle, input)).toBe(settle.errors.reference);
    });
});

describe("Phase 20B — manual-transfer bodies", () => {
    it("sends a refund settle as transferRef, trimmed, with a 3+ note", () => {
        expect(
            manualTransferBody(MANUAL_TRANSFER_DIALOGS.settle, {
                reference: "  TRX-20260925-00123  ",
                note: "  BCA 1234567890  ",
            })
        ).toEqual({
            transferRef: "TRX-20260925-00123",
            note: "BCA 1234567890",
        });
    });

    it("sends a settlement as providerReference, which is its schema's field name", () => {
        expect(
            manualTransferBody(MANUAL_TRANSFER_DIALOGS.paid, {
                reference: " TRX-20260925-00456 ",
                note: " Mandiri 9876543210 ",
            })
        ).toEqual({
            providerReference: "TRX-20260925-00456",
            note: "Mandiri 9876543210",
        });
    });

    it("sends the three reason-only dialogs as reason, never carrying a note", () => {
        for (const kind of ["reject", "fail", "settleFail"] as const) {
            expect(
                manualTransferBody(MANUAL_TRANSFER_DIALOGS[kind], {
                    reason: "  rekening tujuan salah  ",
                    note: "catatan yang tidak relevan",
                    reference: "TRX-999",
                })
            ).toEqual({ reason: "rekening tujuan salah" });
        }
    });
});

describe("Phase 20B — manual-transfer lifecycle", () => {
    it("opens with empty, unscrolded fields and emits nothing", () => {
        const { state, effects } = run(initialManualTransferState, {
            type: "open",
            kind: "settle",
        });

        expect(effects).toEqual([]);
        expect(state.openKind).toBe("settle");
        expect(state.input).toEqual({});
        expect(state.pending).toBeNull();
        expect(state.error).toBeNull();
        expect(state.showErrors).toBe(false);
    });

    it("cancelling sends nothing and leaves no value behind", () => {
        const state = opened("reject", { reason: "alasan" });
        const { state: next, effects } = run(state, { type: "cancel" });

        expect(effects).toEqual([]);
        expect(next.openKind).toBeNull();
        expect(next.error).toBeNull();
        expect(next.showErrors).toBe(false);

        const reopened = run(next, { type: "open", kind: "reject" }).state;
        expect(reopened.input).toEqual({});
    });

    it("submitting nothing starts no request and scolds the operator", () => {
        const { state, effects } = run(initialManualTransferState, { type: "submit" });

        expect(effects).toEqual([]);
        expect(state).toBe(initialManualTransferState);
    });

    it("submitting an empty required field starts no request", () => {
        const { state, effects } = run(opened("settle"), { type: "submit" });

        expect(effects).toEqual([]);
        expect(state.pending).toBeNull();
        expect(state.showErrors).toBe(true);
        expect(state.openKind).toBe("settle");
    });

    it("submitting a valid dialog starts exactly one request with the schema's body", () => {
        const state = opened("settle", {
            reference: " TRX-20260925-00123 ",
            note: "BCA 1234567890",
        });
        const { state: next, effects } = run(state, { type: "submit" });

        expect(starts(effects)).toEqual([
            {
                type: "start",
                kind: "settle",
                action: "settle",
                body: {
                    transferRef: "TRX-20260925-00123",
                    note: "BCA 1234567890",
                },
            },
        ]);
        expect(next.pending).toBe("settle");
        expect(next.showErrors).toBe(false);
    });

    it("a second click while the request is in flight starts no second one", () => {
        const submitted = run(
            opened("paid", { reference: "TRX-20260925-00456" }),
            { type: "submit" }
        ).state;
        const { state, effects } = run(submitted, { type: "submit" });

        expect(effects).toEqual([]);
        expect(state).toBe(submitted);
    });

    it("a success closes the dialog and resets it for the next action", () => {
        const submitted = run(
            opened("settle", { reference: "TRX-1" }),
            { type: "submit" }
        ).state;
        const { state, effects } = run(submitted, {
            type: "completed",
            action: "settle",
            ok: true,
        });

        expect(effects).toEqual([{ type: "finished", action: "settle", ok: true }]);
        expect(state.openKind).toBeNull();
        expect(state.input).toEqual({});
        expect(state.pending).toBeNull();
        expect(state.error).toBeNull();
    });

    it("a failure keeps the dialog open, shows the server's message, and allows a retry", () => {
        const submitted = run(
            opened("paid", { reference: "TRX-1" }),
            { type: "submit" }
        ).state;
        const failed = run(submitted, {
            type: "completed",
            action: "paid",
            ok: false,
            error: "Status settlement tidak memenuhi syarat.",
        });

        expect(failed.effects).toEqual([{ type: "finished", action: "paid", ok: false }]);
        expect(failed.state.openKind).toBe("paid");
        expect(failed.state.pending).toBeNull();
        expect(failed.state.error).toBe("Status settlement tidak memenuhi syarat.");
        expect(failed.state.input.reference).toBe("TRX-1");

        const retried = run(failed.state, { type: "submit" });
        expect(starts(retried.effects)).toHaveLength(1);
    });

    it("a failure with no message from the server still says something", () => {
        const submitted = run(
            opened("reject", { reason: "alasan" }),
            { type: "submit" }
        ).state;
        const { state } = run(submitted, {
            type: "completed",
            action: "reject",
            ok: false,
        });

        expect(state.error).toBeTruthy();
        expect(state.openKind).toBe("reject");
    });

    it("editing after a refusal clears that refusal", () => {
        const submitted = run(
            opened("fail", { reason: "alasan" }),
            { type: "submit" }
        ).state;
        const failed = run(submitted, {
            type: "completed",
            action: "fail",
            ok: false,
            error: "Ditolak server.",
        }).state;
        const edited = run(failed, {
            type: "change",
            field: "reason",
            value: "alasan lain",
        }).state;

        expect(edited.error).toBeNull();
        expect(edited.showErrors).toBe(true);
        expect(edited.input.reason).toBe("alasan lain");
    });

    it("typing reveals an invalid value; an untouched dialog does not", () => {
        const openedState = run(initialManualTransferState, {
            type: "open",
            kind: "settle",
        }).state;
        expect(openedState.showErrors).toBe(false);

        const typed = run(openedState, {
            type: "change",
            field: "reference",
            value: "ab",
        }).state;
        expect(typed.showErrors).toBe(true);
    });

    it("ignores a completion for an action that is not the one in flight", () => {
        const submitted = run(
            opened("settle", { reference: "TRX-1" }),
            { type: "submit" }
        ).state;
        const { state } = run(submitted, {
            type: "completed",
            action: "paid",
            ok: true,
        });

        expect(state.pending).toBe("settle");
        expect(state.openKind).toBe("settle");
    });
});

describe("Phase 20B — dialog wiring guards", () => {
    const components: [string, string][] = [
        ["refund", REFUND_ACTIONS],
        ["settlement", SETTLEMENT_ACTIONS],
    ];

    it.each(components)("the %s actions contain no native dialog", (_name, file) => {
        const source = code(read(file));

        expect(source).not.toMatch(/window\s*\.\s*(prompt|confirm|alert)/);
        expect(source).not.toMatch(/(^|[^.\w])(prompt|confirm)\s*\(/);
    });

    it.each(components)("the %s actions drive the shared machine and the dashboard Dialog", (_name, file) => {
        const source = code(read(file));

        expect(source).toContain("useManualTransferDialog");
        expect(source).toContain("./use-manual-transfer-dialog");
        expect(source).toContain("getManualTransferDefinition");
        expect(source).toContain("@/components/dashboard/ui/dialog");
        expect(source).toContain("DialogContent");
    });

    it("the machine and its hook are the only places a manual-transfer body is built", () => {
        for (const [, file] of components) {
            expect(code(read(file))).not.toContain("manualTransferBody");
        }

        expect(code(read(MACHINE))).toContain("export function manualTransferBody");
        expect(code(read(HOOK))).toContain('method: "POST"');
    });

    it("the refund actions keep posting to the refund routes", () => {
        const source = code(read(REFUND_ACTIONS));

        expect(source).toContain("/api/ticketing/refunds/${refundId}/${action}");
        expect(source).toContain('method: "POST"');
        expect(source).toContain('"Content-Type": "application/json"');
    });

    it("the settlement actions keep posting to the settlement routes and uploading proof as a file", () => {
        const source = code(read(SETTLEMENT_ACTIONS));

        expect(source).toContain(
            "/api/organizer/settlements/${settlementId}/${action}"
        );
        expect(source).toContain(
            "/api/organizer/settlements/${settlementId}/proof"
        );
        expect(source).toContain("FormData");
        expect(source).toContain('type="file"');
    });

    it("the two components that used to prompt no longer import the browser-only helpers", () => {
        for (const [, file] of components) {
            const source = code(read(file));

            expect(source).not.toMatch(/requireSameOrigin/);
            expect(source).not.toMatch(/readStored/);
        }
    });
});
