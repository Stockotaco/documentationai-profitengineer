#!/usr/bin/env python3
"""Validate documentation.json against the pages on disk. Run before pushing nav edits.

    python3 scripts/check-nav.py

WHY THIS EXISTS. A tab holds its children under `pages` OR `groups`, never both —
this repo uses both shapes across different tabs, which is legal per-tab and fatal
when mixed. Editing the MCP tab with `setdefault("groups", [])` created a second,
competing key on a tab that used `pages`; the renderer honoured one and silently
dropped the other, and the published MCP tab lost its sidebar and its tab bar.

A link checker does not catch it. Walking every `path` key recursively finds both
copies and reports everything as resolvable, because the targets ARE fine — it is
the container that is wrong. Hence a schema check, separate from a link check.
"""
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    config = json.loads((HERE / "documentation.json").read_text())
    files = {str(p.relative_to(HERE))[:-4] for p in HERE.rglob("*.mdx")
             if "node_modules" not in str(p)}
    problems: list[str] = []
    seen: set[str] = set()

    def check_group(group: dict, where: str) -> None:
        name = group.get("group", "<unnamed>")
        if "group" not in group:
            problems.append(f"{where}: group entry with no `group` name")
        # A group must carry pages or an openapi spec. An empty one renders as a
        # dead heading.
        if not group.get("pages") and "openapi" not in group:
            problems.append(f"{where}/{name}: empty group and no openapi key")
        for entry in group.get("pages", []):
            if "group" in entry:
                check_group(entry, f"{where}/{name}")
            elif "path" in entry:
                seen.add(entry["path"])
                if entry["path"] not in files:
                    problems.append(f"{where}/{name}: no .mdx for {entry['path']}")
            else:
                problems.append(f"{where}/{name}: entry with neither path nor group")

    for tab in config["navigation"]["tabs"]:
        name = tab.get("tab", "<unnamed>")
        if "pages" in tab and "groups" in tab:
            problems.append(
                f"tab {name}: has BOTH `pages` and `groups`. A tab holds its children "
                f"under one key; the renderer honours one and drops the other, which "
                f"empties the sidebar without any error")
        if "pages" not in tab and "groups" not in tab:
            problems.append(f"tab {name}: neither `pages` nor `groups`")
        for container in ("groups", "pages"):
            for entry in tab.get(container, []):
                if "group" in entry:
                    check_group(entry, f"tab {name}")
                elif "path" in entry:
                    seen.add(entry["path"])
                    if entry["path"] not in files:
                        problems.append(f"tab {name}: no .mdx for {entry['path']}")

    orphans = sorted(files - seen)
    if orphans:
        problems.append(f"pages unreachable from the nav: {', '.join(orphans)}")

    if problems:
        print("nav problems:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    tabs = [t.get("tab") for t in config["navigation"]["tabs"]]
    print(f"nav ok — {len(tabs)} tabs ({', '.join(tabs)}), {len(seen)} pages, all resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
