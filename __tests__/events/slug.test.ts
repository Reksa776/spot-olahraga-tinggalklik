/**
 * ==========================================
 * PHASE 4 — EVENT SLUGS (design §10.6, brief §9)
 * ==========================================
 *
 * Pure tests: no database. Uniqueness is injected as a predicate, so the collision
 * logic is proven deterministically rather than by racing real rows.
 */

import {
    RESERVED_SLUGS,
    generateUniqueSlug,
    isAcceptableRequestedSlug,
    slugBodyFromTitle,
    slugify,
} from "@/lib/events/slug";

describe("slugify — normalised and URL-safe", () => {
    test("lowercases and hyphenates", () => {
        expect(slugify("Final Basketball Championship 2026")).toBe(
            "final-basketball-championship-2026"
        );
    });

    test("folds diacritics to ASCII rather than dropping the letter", () => {
        expect(slugify("Lömbä Bola Völi")).toBe("lomba-bola-voli");
        expect(slugify("Turnamen Futsal Café")).toBe("turnamen-futsal-cafe");
    });

    test("collapses separators and strips leading/trailing dashes", () => {
        expect(slugify("  --Badminton   Open--  ")).toBe("badminton-open");
        expect(slugify("a___b")).toBe("a-b");
    });

    test("removes characters that are unsafe in a URL path", () => {
        expect(slugify("Cup 2026/2027 #1")).toBe("cup-2026-2027-1");
        expect(slugify("../../etc/passwd")).toBe("etc-passwd");
        expect(slugify("a?b=c&d")).toBe("a-b-c-d");
        // Percent-encoding must not survive as literal percent characters.
        expect(slugify("100%25 Off")).toBe("100-25-off");
    });

    test("never returns a slug containing a slash or a dot-dot", () => {
        for (const hostile of [
            "../secrets",
            "a/../b",
            "..",
            "/absolute/path",
            "a\\b",
        ]) {
            const out = slugify(hostile);

            expect(out).not.toContain("/");
            expect(out).not.toContain("\\");
            expect(out).not.toContain("..");
        }
    });

    test("is deterministic", () => {
        const input = "Turnamen Bulu Tangkis Nasional 2026";

        expect(slugify(input)).toBe(slugify(input));
    });

    test("is bounded in length and does not end on a dash after truncation", () => {
        const long = "a".repeat(200);
        const out = slugify(long);

        expect(out.length).toBeLessThanOrEqual(80);
        expect(out.endsWith("-")).toBe(false);
    });

    test("returns an empty string when nothing usable remains", () => {
        expect(slugify("")).toBe("");
        expect(slugify("!!!")).toBe("");
        expect(slugify("🎉🎉")).toBe("");
    });
});

describe("slugBodyFromTitle — fallbacks", () => {
    test("falls back when a title slugifies to nothing", () => {
        expect(slugBodyFromTitle("🎉")).toBe("event");
        expect(slugBodyFromTitle("")).toBe("event");
    });

    test("never mints a reserved slug", () => {
        for (const reserved of RESERVED_SLUGS) {
            expect(RESERVED_SLUGS).toContain(reserved);
            expect(slugBodyFromTitle(reserved)).not.toBe(reserved);
        }
    });

    test("pads a very short body so it does not collide constantly", () => {
        expect(slugBodyFromTitle("a")).toBe("a-event");
        expect(slugBodyFromTitle("ab")).toBe("ab-event");
        expect(slugBodyFromTitle("abc")).toBe("abc");
    });
});

describe("generateUniqueSlug — collision-safe", () => {
    test("uses the plain body when it is free", async () => {
        const slug = await generateUniqueSlug("Futsal Open", async () => false);

        expect(slug).toBe("futsal-open");
    });

    test("appends a short suffix when the body is taken", async () => {
        let calls = 0;

        const slug = await generateUniqueSlug("Futsal Open", async () => {
            calls++;
            return true;
        });

        expect(calls).toBeGreaterThanOrEqual(2);
        expect(slug.startsWith("futsal-open-")).toBe(true);
        // "futsal-open-" + a suffix, so the result is longer than the bare body.
        expect(slug.length).toBeGreaterThan("futsal-open".length);
    });

    test("the candidate it finally returns is one the predicate reported free", async () => {
        const taken = new Set(["futsal-open", "futsal-open-aaaaaa"]);
        const checked: string[] = [];

        const slug = await generateUniqueSlug("Futsal Open", async (candidate) => {
            checked.push(candidate);
            return taken.has(candidate);
        });

        expect(checked).toContain(slug);
        expect(taken.has(slug)).toBe(false);
    });

    test("exhausting every attempt still returns a longer-suffixed candidate", async () => {
        // Simulates a pathological state where everything is taken. The function must
        // return rather than loop forever; the database unique constraint is the final
        // defence.
        let calls = 0;

        const slug = await generateUniqueSlug("Futsal Open", async () => {
            calls++;
            return true;
        });

        expect(calls).toBeGreaterThanOrEqual(6);
        expect(slug.startsWith("futsal-open-")).toBe(true);
    });

    test("two generations against an empty database do not produce the same slug twice in a row", async () => {
        // Not a uniqueness proof (the database provides that) but it verifies the
        // suffix is actually random rather than constant.
        const suffixes = new Set<string>();

        for (let i = 0; i < 5; i++) {
            const slug = await generateUniqueSlug("Futsal Open", async (c) => c === "futsal-open");
            suffixes.add(slug);
        }

        expect(suffixes.size).toBeGreaterThan(1);
    });
});

describe("isAcceptableRequestedSlug — structural only", () => {
    test("accepts a well-formed slug", () => {
        expect(isAcceptableRequestedSlug("final-basketball-2026")).toBe(true);
        expect(isAcceptableRequestedSlug("abc")).toBe(true);
    });

    test("rejects anything that would normalise into a different slug", () => {
        for (const bad of [
            "",
            "   ",
            "Final Basketball", // uppercase + space
            "Final-Basketball", // uppercase
            "trailing-",
            "-leading",
            "double--dash",
            "under_score",
            "caf\u00e9", // an accented form would change after normalisation
            "../etc",
            "a/b",
            "a.b",
        ]) {
            expect(isAcceptableRequestedSlug(bad)).toBe(false);
        }
    });

    test("rejects reserved slugs so a slug change cannot shadow a route", () => {
        for (const reserved of RESERVED_SLUGS) {
            expect(isAcceptableRequestedSlug(reserved)).toBe(false);
        }
    });

    test("rejects an over-long slug", () => {
        expect(isAcceptableRequestedSlug("a".repeat(81))).toBe(false);
    });

    test("rejects non-strings without throwing", () => {
        expect(isAcceptableRequestedSlug(undefined as unknown as string)).toBe(false);
        expect(isAcceptableRequestedSlug(null as unknown as string)).toBe(false);
        expect(isAcceptableRequestedSlug(42 as unknown as string)).toBe(false);
    });
});
