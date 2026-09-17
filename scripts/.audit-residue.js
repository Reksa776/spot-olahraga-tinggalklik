/* Throwaway audit: dashboard/back-office Tailwind residue. Deleted at the end of the phase. */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

// Dashboard-owned directories and files.
const TARGET_DIRS = [
    "app/admin",
    "app/organizer",
    "app/platform",
    "components/admin",
    "components/organizer",
    "components/platform",
];

// Files explicitly protected by earlier phases / shared with the customer graph.
const PROTECTED = new Set([
    "components/ui/Dialog.tsx",
]);

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

function isTailwindClassLine(line) {
    // A rough but effective signal: className="..." containing tailwind-shaped utilities.
    if (!/className=/.test(line)) return false;
    return /\b(rounded-|border|bg-white|bg-gray|bg-rose|bg-blue|bg-ink|bg-brand|text-gray|text-rose|text-blue|text-ink|text-brand|px-|py-|p-[0-9]|m-[0-9]|mt-|mb-|ml-|mr-|flex|grid|gap-|w-full|h-[0-9]|space-y|space-x|font-semibold|font-bold|shadow|hover:|focus:|sm:|md:|lg:|xl:)/.test(
        line
    );
}

const results = [];
for (const dir of TARGET_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).replace(/\\/g, "/");
        const src = fs.readFileSync(file, "utf8");
        const lines = src.split("\n");
        let twLines = 0;
        for (const line of lines) if (isTailwindClassLine(line)) twLines++;
        if (!twLines) continue;

        const usesMantine = /from "@mantine\//.test(src);
        const rawButton = (src.match(/<button[\s>]/g) || []).length;
        const rawInput = /<input[\s>]/.test(src);
        const rawSelect = /<select[\s>]/.test(src);
        const rawTextarea = /<textarea[\s>]/.test(src);
        const rawTable = /<table[\s>]/.test(src);

        results.push({
            rel,
            lines: lines.length,
            twLines,
            mantine: usesMantine,
            protected: PROTECTED.has(rel),
            raw: { rawButton, rawInput, rawSelect, rawTextarea, rawTable },
        });
    }
}

results.sort((a, b) => b.twLines - a.twLines);

let totalTwLines = 0;
let totalLines = 0;
console.log("=== DASHBOARD TAILWIND RESIDUE ===\n");
for (const r of results) {
    totalTwLines += r.twLines;
    totalLines += r.lines;
    const flags = [];
    if (r.protected) flags.push("PROTECTED");
    if (!r.mantine) flags.push("no-mantine");
    if (r.raw.rawButton) flags.push(`button:${r.raw.rawButton}`);
    if (r.raw.rawInput) flags.push("input");
    if (r.raw.rawSelect) flags.push("select");
    if (r.raw.rawTextarea) flags.push("textarea");
    if (r.raw.rawTable) flags.push("table");
    console.log(
        `${String(r.twLines).padStart(4)} tw / ${String(r.lines).padStart(5)} ln  ${r.rel}  ${flags.join(" ")}`
    );
}
console.log(`\nFILES: ${results.length}   TW-LINES: ${totalTwLines}   TOTAL-LINES: ${totalLines}`);
