import { createHash, timingSafeEqual } from "node:crypto";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { isLoopbackGatewayHost } from "./config";
import {
    isValidDeliveryId,
    validateReconciliation,
    validateTextDispatch,
    type GatewayOperations,
} from "./protocol";

/**
 * Internal gateway HTTP server.
 *
 * It binds loopback only, requires `Authorization: Bearer <WA_GATEWAY_TOKEN>` on every route
 * (including health), caps the body at `maxBodyBytes`, and returns only safe status fields.
 * There is no route that returns a QR, session file, phone number or message body.
 */

class HttpError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
    }
}

function safeTokenEqual(provided: string, expected: string): boolean {
    const left = createHash("sha256").update(provided).digest();
    const right = createHash("sha256").update(expected).digest();

    return timingSafeEqual(left, right);
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    if (res.headersSent) {
        return;
    }

    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(payload);
}

async function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();

    if (contentType !== "application/json") {
        throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }

    const declaredLength = Number(req.headers["content-length"] ?? "0");

    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;

        if (size > maxBodyBytes) {
            throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
        }

        chunks.push(buffer);
    }

    if (size === 0) {
        throw new HttpError(400, "EMPTY_BODY", "A JSON body is required.");
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
    }
}

export class GatewayHttpServer {
    private server: Server | null = null;

    constructor(
        private readonly operations: GatewayOperations,
        private readonly token: string,
        private readonly maxBodyBytes: number
    ) {}

    async start(port: number, host: string): Promise<void> {
        if (!isLoopbackGatewayHost(host)) {
            throw new Error("The WhatsApp gateway refuses to bind a non-loopback address.");
        }

        if (this.server) {
            return;
        }

        const server = createServer((req, res) => {
            void this.handle(req, res).catch((error: unknown) => {
                if (error instanceof HttpError) {
                    sendJson(res, error.statusCode, {
                        error: error.code,
                        message: error.message,
                    });
                    return;
                }

                sendJson(res, 500, {
                    error: "INTERNAL_ERROR",
                    message: "The gateway could not process this request.",
                });
            });
        });

        server.headersTimeout = 10_000;
        server.requestTimeout = 15_000;
        server.keepAliveTimeout = 5_000;

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };

            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, host);
        });

        this.server = server;
    }

    async close(): Promise<void> {
        const server = this.server;

        if (!server) {
            return;
        }

        this.server = null;

        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections?.();
        });
    }

    get address(): { host: string; port: number } | null {
        const address = this.server?.address();

        if (!address || typeof address === "string") {
            return null;
        }

        return { host: address.address, port: address.port };
    }

    private authorize(req: IncomingMessage): void {
        const header = req.headers.authorization;

        if (!header || !header.startsWith("Bearer ")) {
            throw new HttpError(401, "UNAUTHORIZED", "A bearer token is required.");
        }

        if (!safeTokenEqual(header.slice("Bearer ".length), this.token)) {
            throw new HttpError(401, "UNAUTHORIZED", "The bearer token is invalid.");
        }
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        this.authorize(req);

        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = url.pathname;

        if (req.method === "GET" && pathname === "/healthz") {
            const snapshot = this.operations.snapshot();
            sendJson(res, 200, {
                status: "ok",
                state: snapshot.state,
                connected: snapshot.connected,
            });
            return;
        }

        if (req.method === "GET" && pathname === "/readyz") {
            const snapshot = this.operations.snapshot();
            sendJson(res, snapshot.ready ? 200 : 503, {
                status: snapshot.ready ? "ready" : "not_ready",
                state: snapshot.state,
                ownershipHeld: snapshot.ownershipHeld,
                sessionPresent: snapshot.sessionPresent,
                connected: snapshot.connected,
            });
            return;
        }

        if (pathname === "/v1/messages/text") {
            if (req.method !== "POST") {
                throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST for dispatch.");
            }

            const body = await readJson(req, this.maxBodyBytes);
            const validated = validateTextDispatch(body);

            if (!validated.ok) {
                throw new HttpError(400, validated.code, validated.message);
            }

            const result = await this.operations.dispatchText(validated.value);

            switch (result.status) {
                case "SENT":
                    sendJson(res, 200, result);
                    return;
                case "FAILED_BEFORE_SEND":
                    sendJson(res, 502, result);
                    return;
                case "AMBIGUOUS":
                case "IN_PROGRESS":
                    sendJson(res, 409, result);
                    return;
                case "NOT_READY":
                    sendJson(res, 503, result);
                    return;
            }
        }

        const match = pathname.match(/^\/v1\/messages\/([^/]+)(\/reconcile)?$/);

        if (match) {
            let deliveryId: string;

            try {
                deliveryId = decodeURIComponent(match[1]);
            } catch {
                throw new HttpError(400, "INVALID_DELIVERY_ID", "deliveryId is malformed.");
            }

            if (!isValidDeliveryId(deliveryId)) {
                throw new HttpError(400, "INVALID_DELIVERY_ID", "deliveryId is malformed.");
            }

            if (match[2]) {
                if (req.method !== "POST") {
                    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST for reconciliation.");
                }

                const body = await readJson(req, this.maxBodyBytes);
                const validated = validateReconciliation(body);

                if (!validated.ok) {
                    throw new HttpError(400, validated.code, validated.message);
                }

                const result = await this.operations.reconcileDelivery(
                    deliveryId,
                    validated.value
                );

                if (result.status === "RECONCILED") {
                    sendJson(res, 200, result);
                } else if (result.status === "NOT_FOUND") {
                    sendJson(res, 404, result);
                } else {
                    sendJson(res, 409, result);
                }
                return;
            }

            if (req.method !== "GET") {
                throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET for delivery lookup.");
            }

            const delivery = await this.operations.getDelivery(deliveryId);

            if (!delivery) {
                throw new HttpError(404, "NOT_FOUND", "No gateway record exists for that deliveryId.");
            }

            sendJson(res, 200, delivery);
            return;
        }

        throw new HttpError(404, "NOT_FOUND", "No such gateway route.");
    }
}
