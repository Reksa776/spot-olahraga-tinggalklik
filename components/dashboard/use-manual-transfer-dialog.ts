"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
    initialManualTransferState,
    manualTransferReducer,
    type ManualTransferAction,
    type ManualTransferDialogKind,
    type ManualTransferField,
    type ManualTransferState,
} from "./manual-transfer-dialog";

type ManualTransferDispatch = (action: ManualTransferAction) => void;

/**
 * Binds the pure manual-transfer machine (./manual-transfer-dialog) to real requests.
 *
 * The component supplies the URL of the action (`/api/ticketing/refunds/7/settle`), and
 * the hook owns the whole lifecycle: one `POST` per `start` effect, a second click while
 * that POST is in flight starts nothing, the server's message is surfaced verbatim on
 * failure, and the dialog resets on success. Nothing here decides validity — that is the
 * machine's job — and nothing here decides authorization either; the API answers both.
 *
 * The reducer is run INSIDE the dispatch, against the state held in a ref, so an effect is
 * handled in the same tick it is produced. React's state update is asynchronous, and a
 * `useEffect` that re-derived the body from rendered state would read a stale input on the
 * first click and re-post on every keystroke.
 */
export function useManualTransferDialog(actionUrl: (action: string) => string) {
    const [state, setState] = useState<ManualTransferState>(initialManualTransferState);

    // Refs, not state: the in-flight guard must read the CURRENT pending value inside the
    // same tick a second click arrives, before React has re-rendered.
    const stateRef = useRef<ManualTransferState>(initialManualTransferState);
    const mountedRef = useRef(true);
    const actionUrlRef = useRef(actionUrl);
    const dispatchRef = useRef<ManualTransferDispatch>(() => undefined);

    useEffect(() => {
        actionUrlRef.current = actionUrl;
    }, [actionUrl]);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const start = useCallback((action: string, body: Record<string, string>) => {
        if (stateRef.current.pending !== null) {
            return;
        }

        void (async () => {
            let ok = false;
            let message: string | null = null;

            try {
                const response = await fetch(actionUrlRef.current(action), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    message = payload?.message ?? "Tindakan gagal.";
                } else {
                    ok = true;
                }
            } catch {
                message = "Tidak dapat menghubungi server.";
            }

            if (mountedRef.current) {
                dispatchRef.current({ type: "completed", action, ok, error: message });
            }
        })();
    }, []);

    const dispatch = useCallback<ManualTransferDispatch>((action) => {
        const current = stateRef.current;
        const { state: next, effects } = manualTransferReducer(current, action);

        stateRef.current = next;

        if (mountedRef.current) {
            setState(next);
        }

        for (const effect of effects) {
            if (effect.type === "start") {
                start(effect.action, effect.body);
            }
        }
    }, [start]);

    useEffect(() => {
        dispatchRef.current = dispatch;
    }, [dispatch]);

    const open = useCallback(
        (kind: ManualTransferDialogKind) => dispatch({ type: "open", kind }),
        [dispatch]
    );

    const close = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);

    const change = useCallback(
        (field: ManualTransferField, value: string) =>
            dispatch({ type: "change", field, value }),
        [dispatch]
    );

    const submit = useCallback(() => dispatch({ type: "submit" }), [dispatch]);

    return {
        state,
        open,
        close,
        change,
        submit,
        isBusy: state.pending !== null,
        values: state.input,
    };
}
