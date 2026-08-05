#!/usr/bin/env node
/**
 * Generates mcp/tools/*.mdx from the gateway's own tool catalog, so the docs
 * cannot drift from the server.
 *
 *   node scripts/gen-tool-pages.mjs            # fetch the live catalog
 *   node scripts/gen-tool-pages.mjs cat.json   # or read a saved copy
 *
 * These docs are for CLIENTS, so the agency-only surface is filtered out:
 * whole families (Clients, Bug Reports, Slack send) and individual tools whose
 * scope is agency-wide-only. That list mirrors the `agencyWideOnly` rows in the
 * platform's shared/src/auth/scopes.ts — if a capability is added there, add it
 * here too or it will leak into client docs.
 */

import { writeFile, mkdir } from "node:fs/promises";

const CATALOG_URL = "https://api-service-production-4d43.up.railway.app/mcp/catalog";
const OUT_DIR = new URL("../mcp/tools/", import.meta.url);

const AGENCY_ONLY_FAMILIES = new Set(["Clients", "Bug Reports", "Slack (send)"]);
const AGENCY_ONLY_SCOPES = new Set(["clients:read", "clients:write", "bugs:read", "bugs:write", "slack:write", "incrementality:write"]);

// A client user can grant these on a key they create themselves. Every read
// scope is self-serve; these are the only writes. Mirrors SELF_SERVE_WRITES.
const SELF_SERVE_WRITES = new Set(["memories:write", "documents:write", "discussions:write", "tasks:write"]);

// The one hand-maintained table: presentation for each family the catalog emits.
// `note` overrides the catalog's own note where it was written for staff.
const FAMILIES = {
    "Read-only": {
        slug: "read-only", icon: "unlock", order: 1,
        title: "Always available",
        description: "Seven tools every key can call without any scope.",
    },
    Metrics: {
        slug: "metrics", icon: "target", order: 2,
        title: "Metrics",
        description: "Your governed metric definitions, their targets, and their resolved values.",
        note: "Metrics are the source of truth. Resolve a governed metric with `get_metric_value` rather than re-deriving the number yourself — that is what makes two people asking the same question get the same answer.",
    },
    Reports: {
        slug: "reports", icon: "file-bar-chart", order: 3,
        title: "Reports",
        description: "List your reports, inspect your data schema, and author new report drafts.",
    },
    Glossary: {
        slug: "glossary", icon: "book-a", order: 4,
        title: "Glossary",
        description: "The shared definitions for your business terms.",
    },
    Documents: {
        slug: "documents", icon: "files", order: 5,
        title: "Documents",
        description: "Your knowledge base, plus the search that reads across it.",
    },
    Memories: {
        slug: "memories", icon: "brain", order: 6,
        title: "Memories",
        description: "Knowledge the AI keeps between sessions so it does not re-derive the same reasoning.",
    },
    Skills: {
        slug: "skills", icon: "graduation-cap", order: 7,
        title: "Skills",
        description: "Instruction playbooks an agent loads on demand with use_skill.",
    },
    Prompts: {
        slug: "prompts", icon: "message-square-quote", order: 8,
        title: "Prompts",
        description: "Your reusable prompt library — an agent can point at one as its system prompt.",
    },
    Discussions: {
        slug: "discussions", icon: "messages-square", order: 9,
        title: "Discussions",
        description: "Threaded conversations on your reports. Reading is always on; these tools write.",
    },
    Alerts: {
        slug: "alerts", icon: "bell", order: 10,
        title: "Alerts",
        description: "Alert rules, their history, and the actions they fire.",
    },
    "Scheduled Tasks": {
        slug: "scheduled-tasks", icon: "clock", order: 11,
        title: "Scheduled tasks",
        description: "Cron-based AI tasks that draft proposals for a human to review.",
    },
    Email: {
        slug: "email", icon: "mail", order: 12,
        title: "Email",
        description: "Read your inbound and outbound email threads. Read-only.",
    },
    Slack: {
        slug: "slack-conversations", icon: "hash", order: 13,
        title: "Slack conversations",
        description: "Read ingested Slack channels by person, recency, and thread. Read-only.",
    },
    Web: {
        slug: "web", icon: "globe", order: 14,
        title: "Web",
        description: "Fetch and scrape web pages. Read-only.",
    },
    "Funnel Constraints": {
        slug: "funnel-constraints", icon: "filter", order: 15,
        title: "Funnel constraints",
        description: "Find which step of your paid funnel a campaign is stuck on.",
    },
    Incrementality: {
        slug: "incrementality", icon: "trending-up", order: 16,
        title: "Incrementality",
        description: "Read geo-holdout experiments and the incrementality coefficients derived from them.",
        note: "Read-only for client keys. Creating, computing, and deleting an experiment changes real Meta ad targeting, so your agency runs those steps for you.",
    },
};

/**
 * MDX treats `{` and `<` as syntax, so neutralise them in prose lifted from the API.
 * Inline code spans are left alone: markdown does not decode entities inside them,
 * so escaping there would render a literal `&lt;`.
 */
const esc = (s) =>
    s
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 ? part : part.replace(/{/g, "&#123;").replace(/}/g, "&#125;").replace(/</g, "&lt;").replace(/>/g, "&gt;")))
        .join("");

const grant = (scope) => {
    if (!scope) return "No scope required.";
    if (scope.endsWith(":read") || SELF_SERVE_WRITES.has(scope)) return `Scope \`${scope}\` — you can grant this on a key you create yourself.`;
    return `Scope \`${scope}\` — your agency grants this one.`;
};

const page = (fam, meta, tools) => {
    const note = meta.note ?? fam.note;
    return `---
generated: "scripts/gen-tool-pages.mjs — do not edit by hand"
title: "${meta.title}"
description: "${meta.description}"
---

${note ? `<Callout kind="info">\n  ${esc(note)}\n</Callout>\n` : ""}
${tools.map((t) => `## ${t.name}\n\n${grant(t.scope)}\n\n${esc(t.desc)}\n`).join("\n")}`;
};

/**
 * The scope reference, derived from the same catalog so the scope→tool mapping
 * can't drift. BigQuery and PostHog scopes are not in the catalog (those tools
 * come from connected servers, not the gateway), so they're listed by hand.
 */
const scopesPage = (rows) => {
    const byScope = new Map();
    for (const r of rows) {
        const s = r.scope ?? "(none)";
        if (!byScope.has(s)) byScope.set(s, []);
        byScope.get(s).push(r.name);
    }
    const line = ([scope, tools]) => {
        const who = scope === "(none)" ? "Always on" : scope.endsWith(":read") || SELF_SERVE_WRITES.has(scope) ? "You" : "Your agency";
        return `| ${scope === "(none)" ? "*none*" : `\`${scope}\``} | ${who} | ${tools.map((t) => `\`${t}\``).join(", ")} |`;
    };
    const sorted = [...byScope].sort((a, b) => (a[0] === "(none)" ? -1 : b[0] === "(none)" ? 1 : a[0].localeCompare(b[0])));
    return `---
generated: "scripts/gen-tool-pages.mjs — do not edit by hand"
title: "Scopes"
description: "Every scope a client key can hold, what it unlocks, and who can grant it."
---

A key carries a list of scopes. A call that needs a scope the key doesn't hold
returns \`403\` with the missing scope named, so you never have to guess.

The **Granted by** column says whether you can add the scope to a key you create
yourself, or whether your agency has to add it for you. See
[Self-serve vs agency-granted](/authorization/self-serve-vs-staff) for why the line
falls where it does.

## Scope reference

| Scope | Granted by | Tools it unlocks |
|-------|-----------|------------------|
${sorted.map(line).join("\n")}

## Warehouse scopes

Your BigQuery and PostHog tools come from servers your agency connects for you, so
they aren't in the table above and their tool names depend on that connection. Your
agency grants all of them.

| Scope | Unlocks |
|-------|---------|
| \`bigquery:projects:read\` | List and read BigQuery projects |
| \`bigquery:datasets:read\` / \`:write\` | Read datasets; create and delete them |
| \`bigquery:tables:read\` / \`:write\` | Read table schemas; create and delete tables |
| \`bigquery:rows:write\` | Insert rows |
| \`bigquery:query:read\` / \`:write\` | Dry-run and inspect jobs; execute queries |
| \`posthog:dashboards:read\` / \`:write\` | Read dashboards and insights; create and edit them |
| \`posthog:queries:read\` / \`:write\` | Run HogQL queries and read definitions; save queries |
| \`posthog:feature-flags:read\` / \`:write\` | Read feature flags; create and edit them |
| \`posthog:surveys:read\` / \`:write\` | Read surveys; create and edit them |
| \`posthog:actions:read\` / \`:write\` | Read actions; create and edit them |
| \`mcp:read\` / \`mcp:write\` | Call tools on MCP servers you connected yourself |

<Callout kind="alert">
  \`mcp:read\` and \`mcp:write\` are decided per tool from the server's own
  annotations, and they fail closed: a tool that doesn't declare itself read-only
  needs \`mcp:write\`, because an unvetted server's effects are unknown.
</Callout>
`;
};

const indexPage = (rows) => `---
generated: "scripts/gen-tool-pages.mjs — do not edit by hand"
title: "All tools"
description: "Every MCP tool available to a client key, with the scope each one needs."
---

${rows.length} tools across ${new Set(rows.map((r) => r.family)).size} families. Tools your agency runs on your behalf are not listed.

| Tool | Family | Scope |
|------|--------|-------|
${rows.map((r) => `| \`${r.name}\` | [${r.title}](/mcp/tools/${r.slug}) | ${r.scope ? `\`${r.scope}\`` : "none" } |`).join("\n")}
`;

const catalog = process.argv[2]
    ? JSON.parse(await (await import("node:fs/promises")).readFile(process.argv[2], "utf8"))
    : await (await fetch(CATALOG_URL)).json();

await mkdir(OUT_DIR, { recursive: true });

const rows = [];
const nav = [];
let skipped = 0;

for (const fam of catalog.families) {
    if (AGENCY_ONLY_FAMILIES.has(fam.family)) {
        skipped += fam.tools.length;
        continue;
    }
    const meta = FAMILIES[fam.family];
    if (!meta) throw new Error(`Catalog has family "${fam.family}" with no entry in FAMILIES — add one (or add it to AGENCY_ONLY_FAMILIES).`);

    const tools = fam.tools.filter((t) => !AGENCY_ONLY_SCOPES.has(t.scope));
    skipped += fam.tools.length - tools.length;
    if (!tools.length) continue;

    await writeFile(new URL(`${meta.slug}.mdx`, OUT_DIR), page(fam, meta, tools));
    for (const t of tools) rows.push({ ...t, family: fam.family, title: meta.title, slug: meta.slug });
    nav.push({ order: meta.order, title: meta.title, path: `mcp/tools/${meta.slug}`, icon: meta.icon });
}

await writeFile(new URL("all-tools.mdx", OUT_DIR), indexPage(rows));

const AUTH_DIR = new URL("../authorization/", import.meta.url);
await mkdir(AUTH_DIR, { recursive: true });
await writeFile(new URL("scopes.mdx", AUTH_DIR), scopesPage(rows));

nav.sort((a, b) => a.order - b.order);
console.log(`${rows.length} client tools in ${nav.length} pages (${skipped} agency-only tools filtered out)`);
console.log("\nnavigation pages for documentation.json:\n");
console.log(JSON.stringify([{ title: "All tools", path: "mcp/tools/all-tools", icon: "list" }, ...nav.map(({ order, ...p }) => p)], null, 2));
