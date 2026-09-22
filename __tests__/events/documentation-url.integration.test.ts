/**
 * ==========================================
 * FEATURE — POST-EVENT DOCUMENTATION LINK (INTEGRATION)
 * ==========================================
 *
 * The documentation link is end-to-end through the REAL organizer-event PATCH route
 * (the strict `parseOrThrow(updateEventSchema, …)` the route runs, not the service —
 * `updateEvent` consumes pre-parsed input, exactly like every other field). A Google
 * Drive URL is stored and read back; `null` clears it; a non-Drive value is a 400 that
 * leaves the stored value alone; a foreign tenant or a membership-less customer gets the
 * never-confirming 404; and the public catalog payload carries the link so the page can
 * render it (the visible gate is the page's COMPLETED check, covered by its unit test).
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { NextRequest, NextResponse } from "next/server";

import { PATCH } from "@/app/api/organizer/events/[id]/route";
import { getPublicEventBySlug } from "@/lib/events/catalog";
import { getOrganizerEvent, updateEvent } from "@/lib/events/service";
import { PERMISSIONS as P, requireOrganizerAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

const ORIGIN = "https://tinggalklik.test";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120000);

const SUFFIX = `doce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const DRIVE_URL = "https://drive.google.com/file/d/1a2b3c4d/view?usp=sharing";
const DOCS_URL = "https://docs.google.com/document/d/target/edit";

let owner: { id: string };
let otherOwner: { id: string };
let customer: { id: string };
let org: { id: string };
let otherOrg: { id: string };
let sport: { id: string };
let event: { id: string; slug: string };

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Test" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

async function scopeFor(userId: string) {
    signInAs(userId);
    return requireOrganizerAccess(org.id, P.EVENT_READ).catch(() => null);
}

async function patchEvent(
    eventId: string,
    body: unknown,
    userId: string
): Promise<NextResponse> {
    signInAs(userId);

    const request = new NextRequest(
        new URL(`${ORIGIN}/api/organizer/events/${eventId}`),
        {
            method: "PATCH",
            headers: {
                "x-forwarded-host": "tinggalklik.test",
                "x-forwarded-proto": "https",
                origin: ORIGIN,
                "content-type": "application/json",
            },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }
    );

    return PATCH(request, { params: Promise.resolve({ id: eventId }) });
}

async function createUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
    });
}

async function storedUrl(): Promise<string | null> {
    const row = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: { documentationUrl: true },
    });

    return row.documentationUrl;
}

beforeAll(async () => {
    owner = await createUser("owner");
    otherOwner = await createUser("other-owner");
    customer = await createUser("customer");

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Docs Org ${SUFFIX}`,
            slug: `docs-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    otherOrg = await prisma.organizer.create({
        data: {
            ownerUserId: otherOwner.id,
            name: `Docs Other ${SUFFIX}`,
            slug: `docs-other-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: otherOrg.id, userId: otherOwner.id, role: "OWNER", status: "ACTIVE" },
        ],
    });

    sport = await prisma.sport.create({
        data: { name: `Docs Sport ${SUFFIX}`, slug: `docs-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });

    event = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId: sport.id,
            title: `Docs Event ${SUFFIX}`,
            slug: `docs-event-${SUFFIX}`,
            eventCode: `TKL-DOC-${SUFFIX}`.slice(0, 40),
            startAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true, slug: true },
    });
});

afterAll(async () => {
    await prisma.event.deleteMany({ where: { id: { in: [event?.id].filter(Boolean) as string[] } } });
    await prisma.sport.delete({ where: { id: sport?.id } });
    await prisma.organizerMember.deleteMany({ where: { userId: { in: [owner?.id, otherOwner?.id].filter(Boolean) as string[] } } });
    await prisma.organizer.deleteMany({ where: { id: { in: [org?.id, otherOrg?.id].filter(Boolean) as string[] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner?.id, otherOwner?.id, customer?.id].filter(Boolean) as string[] } } });
});

describe("documentationUrl — organizer sets, reads, clears through the route", () => {
    it("an OWNER PATCHes a Drive link and reads it back", async () => {
        const response = await patchEvent(event.id, { documentationUrl: DRIVE_URL }, owner.id);

        expect(response.status).toBe(200);
        expect((await response.json()).data.documentationUrl).toBe(DRIVE_URL);

        const scope = await scopeFor(owner.id);
        expect((await getOrganizerEvent(scope!, event.id)).documentationUrl).toBe(DRIVE_URL);
    });

    it("a docs.google.com link is accepted too", async () => {
        const response = await patchEvent(event.id, { documentationUrl: DOCS_URL }, owner.id);

        expect(response.status).toBe(200);
        expect((await response.json()).data.documentationUrl).toBe(DOCS_URL);
    });

    it("an explicit null clears the link through the route", async () => {
        const response = await patchEvent(event.id, { documentationUrl: null }, owner.id);

        expect(response.status).toBe(200);
        expect((await response.json()).data.documentationUrl).toBeNull();

        const scope = await scopeFor(owner.id);
        expect((await getOrganizerEvent(scope!, event.id)).documentationUrl).toBeNull();
    });
});

describe("documentationUrl — non-Drive input is refused with 400", () => {
    it.each([
        "http://drive.google.com/file/d/x",
        "https://imgur.com/gallery/x",
        "https://drive.google.com.evil.example/x",
        "https://drive.google.com@evil.example/x",
        "javascript:alert(1)",
    ])("refuses %s", async (url) => {
        const response = await patchEvent(event.id, { documentationUrl: url }, owner.id);

        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.success).toBe(false);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body.details?.fields ?? [])).toContain("documentationUrl");
    });

    it("leaves the stored value untouched after a refusal", async () => {
        await patchEvent(event.id, { documentationUrl: DRIVE_URL }, owner.id);

        const response = await patchEvent(
            event.id,
            { documentationUrl: "https://imgur.com/x" },
            owner.id
        );

        expect(response.status).toBe(400);
        expect(await storedUrl()).toBe(DRIVE_URL);
    });
});

describe("documentationUrl — tenant boundary holds through the route", () => {
    it("an organizer of another tenant gets the never-confirming 404", async () => {
        const response = await patchEvent(
            event.id,
            { documentationUrl: DRIVE_URL },
            otherOwner.id
        );

        expect(response.status).toBe(404);
    });

    it("a customer with no membership gets the same 404", async () => {
        const response = await patchEvent(event.id, { documentationUrl: DRIVE_URL }, customer.id);

        expect(response.status).toBe(404);
    });
});

describe("documentationUrl — public catalog payload carries it", () => {
    it("the detail payload exposes the link once set (rendering gate lives in the page)", async () => {
        await patchEvent(event.id, { documentationUrl: DRIVE_URL }, owner.id);

        const detail = await getPublicEventBySlug(event.slug, ORIGIN);
        expect(detail.documentationUrl).toBe(DRIVE_URL);
    });

    it("the service preserves the field through its own update path", async () => {
        const scope = await scopeFor(owner.id);

        const updated = await updateEvent(scope!, event.id, {
            documentationUrl: null,
        } as never);

        expect(updated.documentationUrl).toBeNull();
    });
});