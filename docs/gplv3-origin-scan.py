#!/usr/bin/env python3
"""Mechanical Git-blame provenance scan for tracked production and test code.

Run from a checkout with:
  python3 /private/tmp/nes-gpl-origin-scan.py --repo "$PWD" \
    --output /private/tmp/nes-gpl-origin-regions.json

This script does not infer legal ownership. It records Git blame line regions
under raw-by-file, move/copy-aware, and move/copy-aware-plus-ignored-format-commit
modes. It also compares current trees against two fixed historical commits.
"""
from __future__ import annotations
import argparse
import ast
import collections
import datetime as dt
import difflib
import json
import re
import subprocess
from pathlib import Path

HEAD = "3de40ca6d2fe6574e57e631dcc261b7f3bedcbc7"
SR_TREAM_TIP = "cddda9326264c570a8832c026ca63e9745f2d057"
SWEEP_TIP = "fa52a26b31d755c3e3d8e1f2d857a77d39cfebbb"
IGNORE_REVS = ["352595e2f1f0ba673dfd28488f86d92040165f7c"]
IGNORE_REV_REASON = {
    IGNORE_REVS[0]: "Commit subject is 'Reformat jump edit manager'; ignore only in third blame mode."
}
BLAME_HEADER = re.compile(r"^([0-9a-f^]{40,}) (\d+) (\d+)(?: (\d+))?$")


def run(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    p = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, check=False)
    if check and p.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed ({p.returncode}): {p.stderr.decode(errors='replace')}")
    return p


def tree(repo: Path, rev: str) -> dict[str, dict[str, str]]:
    raw = run(repo, "ls-tree", "-r", "-z", "--full-tree", rev).stdout
    result = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        meta, path_b = record.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        path = path_b.decode("utf-8", "surrogateescape")
        result[path] = {"mode": mode, "type": kind, "blob": oid}
    return result


def blob(repo: Path, oid: str) -> bytes:
    return run(repo, "cat-file", "blob", oid).stdout


def parse_filename(value: str) -> str:
    # Caller passes the metadata value after splitting on the first space.
    # Accept the full porcelain record too, so the helper is safe to reuse.
    if value.startswith("filename "):
        value = value[len("filename "):]
    if value.startswith('"'):
        try:
            return ast.literal_eval(value)
        except (SyntaxError, ValueError):
            pass
    return value


def parse_blame(raw: bytes) -> list[dict]:
    lines = raw.decode("utf-8", "replace").splitlines()
    rows = []
    i = 0
    while i < len(lines):
        match = BLAME_HEADER.match(lines[i])
        if not match:
            i += 1
            continue
        oid, orig, final = match.group(1).lstrip("^"), int(match.group(2)), int(match.group(3))
        i += 1
        meta = {}
        content = None
        while i < len(lines):
            line = lines[i]
            if line.startswith("\t"):
                content = line[1:]
                i += 1
                break
            if BLAME_HEADER.match(line):
                break
            key, sep, value = line.partition(" ")
            if sep:
                meta[key] = value
            i += 1
        rows.append({
            "commit": oid, "origin_line": orig, "current_line": final,
            "author": meta.get("author"), "author_email": meta.get("author-mail", "").strip("<>"),
            "author_time": meta.get("author-time"), "author_tz": meta.get("author-tz"),
            "summary": meta.get("summary"), "origin_path": parse_filename(meta["filename"]) if "filename" in meta else None,
            "content": content,
        })
    return rows


def make_regions(rows: list[dict], ancestry_class) -> list[dict]:
    regions = []
    for row in rows:
        item = {k: v for k, v in row.items() if k != "content"}
        item["origin_class"] = ancestry_class(row["commit"])
        if regions:
            prev = regions[-1]
            if (prev["current_end"] + 1 == row["current_line"]
                and prev["commit"] == item["commit"]
                and prev["origin_path"] == item["origin_path"]
                and prev["author"] == item["author"]
                and prev["summary"] == item["summary"]
                and prev["origin_end"] + 1 == item["origin_line"]):
                prev["current_end"] = row["current_line"]
                prev["origin_end"] = item["origin_line"]
                prev["line_count"] += 1
                continue
        regions.append({
            "current_start": row["current_line"], "current_end": row["current_line"],
            "origin_start": item["origin_line"], "origin_end": item["origin_line"],
            "line_count": 1, **item,
        })
    return regions


def role(path: str) -> str | None:
    if path.startswith("src/") or path.startswith("tools/zeta-server/src/"):
        return "production"
    if path.startswith("tools/zeta-server/typings/"):
        return "production_support"
    if path.startswith("test/") or path.startswith("tools/zeta-server/tests/"):
        return "test"
    return None


def normalized_lines(data: bytes) -> list[str]:
    return [re.sub(r"\s+", " ", line.decode("utf-8", "replace")).strip()
            for line in data.splitlines() if line.strip()]


def line_compare(a: list[str], b: list[str]) -> dict:
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    matched = sum(m.size for m in sm.get_matching_blocks())
    return {"left_line_count": len(a), "right_line_count": len(b),
            "ordered_matching_lines": matched,
            "sequence_ratio": round(2 * matched / (len(a) + len(b)), 6) if a or b else 1.0}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=Path.cwd())
    ap.add_argument("--output", type=Path, default=Path("/private/tmp/nes-gpl-origin-regions.json"))
    args = ap.parse_args()
    repo = args.repo.resolve()
    head_tree = tree(repo, HEAD)
    baseline_trees = {"sr_tream_tip": tree(repo, SR_TREAM_TIP), "sweep_tip": tree(repo, SWEEP_TIP)}
    baseline_rev = {"sr_tream_tip": SR_TREAM_TIP, "sweep_tip": SWEEP_TIP}
    ancestry_cache: dict[tuple[str, str], bool] = {}

    def is_ancestor(commit: str, rev: str) -> bool:
        key = (commit, rev)
        if key not in ancestry_cache:
            p = run(repo, "merge-base", "--is-ancestor", commit, rev, check=False)
            ancestry_cache[key] = p.returncode == 0
        return ancestry_cache[key]

    def classify_origin(commit: str) -> str:
        if is_ancestor(commit, SWEEP_TIP):
            return "sweep_or_earlier"
        if is_ancestor(commit, SR_TREAM_TIP):
            return "sr_tream_after_sweep_before_aaron"
        return "after_latest_inherited_sr_tream_tip_or_non_ancestor"

    eligible = [(p, r) for p, r in sorted(head_tree.items()) if role(p)]
    files = []
    aggregate = {mode: collections.Counter() for mode in ("raw", "move_copy_aware", "move_copy_aware_ignore_reformat")}
    origin_aggregate = {mode: collections.Counter() for mode in aggregate}
    for path, current in eligible:
        file_entry = {"path": path, "role": role(path), "head_blob": current["blob"], "head_mode": current["mode"]}
        for label, bt in baseline_trees.items():
            prior = bt.get(path)
            file_entry.setdefault("baseline_path_status", {})[label] = (
                "absent_path" if prior is None else
                "unchanged_blob_and_mode" if prior["blob"] == current["blob"] and prior["mode"] == current["mode"] else
                "same_path_changed_blob_or_mode")
            if prior:
                file_entry.setdefault("baseline_blobs", {})[label] = prior["blob"]
        modes = {
            "raw": ["blame", "--line-porcelain", "-w", HEAD, "--", path],
            "move_copy_aware": ["blame", "--line-porcelain", "-w", "-M", "-C", "-C", HEAD, "--", path],
            "move_copy_aware_ignore_reformat": ["blame", "--line-porcelain", "-w", "-M", "-C", "-C",
                                                   *[f"--ignore-rev={x}" for x in IGNORE_REVS], HEAD, "--", path],
        }
        attribution = {}
        for mode, git_args in modes.items():
            proc = run(repo, *git_args, check=False)
            if proc.returncode:
                attribution[mode] = {"error": proc.stderr.decode("utf-8", "replace").strip()}
                continue
            rows = parse_blame(proc.stdout)
            regions = make_regions(rows, classify_origin)
            attribution[mode] = {"command_flags": git_args[1:-3], "blamed_lines": len(rows), "region_count": len(regions), "regions": regions}
            for row in rows:
                aggregate[mode][file_entry["role"]] += 1
                origin_aggregate[mode][classify_origin(row["commit"])] += 1
        file_entry["blame"] = attribution
        files.append(file_entry)

    special = {}
    old_prompt = baseline_trees["sr_tream_tip"].get("src/api/sweep-prompt.ts")
    current_prompt = head_tree.get("src/api/prompt-utils.ts")
    if old_prompt and current_prompt:
        left, right = blob(repo, old_prompt["blob"]), blob(repo, current_prompt["blob"])
        exact = line_compare(left.decode("utf-8", "replace").splitlines(), right.decode("utf-8", "replace").splitlines())
        norm = line_compare(normalized_lines(left), normalized_lines(right))
        special["prompt_utils_extraction"] = {
            "baseline_commit": SR_TREAM_TIP, "baseline_path": "src/api/sweep-prompt.ts",
            "current_commit": HEAD, "current_path": "src/api/prompt-utils.ts",
            "git_follow_candidate": {"status": "R020", "commit": "b52a58973db330060c94334c85fe937a906ead66"},
            "exact_line_comparison": exact, "whitespace_collapsed_nonblank_line_comparison": norm,
            "caveat": "Path similarity is evidence of moved/extracted text, not an identity or legal-status verdict."
        }

    detailed_attribution = {}
    for mode in ("raw", "move_copy_aware", "move_copy_aware_ignore_reformat"):
        buckets = {}
        for f in files:
            result = f["blame"][mode]
            if "regions" not in result:
                continue
            for region in result["regions"]:
                key = (f["role"], region["origin_class"])
                b = buckets.setdefault(key, {"lines": 0, "regions": 0, "files": set()})
                b["lines"] += region["line_count"]
                b["regions"] += 1
                b["files"].add(f["path"])
        detailed_attribution[mode] = {
            f"{role}|{origin}": {"lines": b["lines"], "regions": b["regions"], "files": len(b["files"])}
            for (role, origin), b in buckets.items()
        }

    # Record each baseline path whose name is absent at HEAD but may feed current line origins.
    current_paths = set(head_tree)
    deleted_by_baseline = {}
    for label, bt in baseline_trees.items():
        deleted_by_baseline[label] = sorted(set(bt) - current_paths)
    result = {
        "scope": {"head": HEAD, "tracked_file_count": len(head_tree), "audited_code_and_test_file_count": len(eligible),
                  "eligible_by_role": dict(collections.Counter(role(p) for p, _ in eligible)),
                  "excluded_tracked_file_count": len(head_tree) - len(eligible),
                  "excluded_paths": sorted(set(head_tree) - {p for p, _ in eligible})},
        "baselines": {k: {"commit": baseline_rev[k], "tracked_file_count": len(v),
                          "deleted_paths_at_head": deleted_by_baseline[k]} for k, v in baseline_trees.items()},
        "blame_modes": {
            "raw": {"flags": ["-w"], "meaning": "Whitespace-insensitive normal blame; no move/copy search."},
            "move_copy_aware": {"flags": ["-w", "-M", "-C", "-C"], "meaning": "Whitespace-insensitive blame with move/copy detection."},
            "move_copy_aware_ignore_reformat": {"flags": ["-w", "-M", "-C", "-C", *[f"--ignore-rev={x}" for x in IGNORE_REVS]],
                "meaning": "Movement-aware blame with known Aaron reformat commit(s) ignored.", "ignored_commits": IGNORE_REV_REASON},
        },
        "origin_classification": {"sweep_or_earlier": "Origin commit is ancestor of fa52a26.",
            "sr_tream_after_sweep_before_aaron": "Origin commit is ancestor of cddda93 but not fa52a26.",
            "after_latest_inherited_sr_tream_tip_or_non_ancestor": "Origin commit is not an ancestor of cddda93; may be Aaron or a non-first-parent commit.",
            "caveat": "Classification uses Git ancestry only. Author names/emails and blame origins do not establish copyright or license rights."},
        "aggregate_blamed_lines_by_role": {m: dict(c) for m,c in aggregate.items()},
        "aggregate_blamed_lines_by_origin_class": {m: dict(c) for m,c in origin_aggregate.items()},
        "aggregate_regions_files_lines_by_role_and_origin_class": detailed_attribution,
        "special_cross_path_comparisons": special,
        "files": files,
        "limitations": [
            "Blame attributes lines to commits and paths in this repository's graph; it is not authorship proof or a licensing determination.",
            "A rewrite, paraphrase, substantial refactor, or moved function may lose blame continuity; -M/-C can find copy-like lines but can also over-attribute common boilerplate.",
            "Whitespace ignore and one explicit format-only ignore revision reduce formatting noise but do not identify every formatting-only change.",
            "Origin regions are line ranges, not semantic symbol boundaries. Baseline path statuses compare names and blobs, while movement-aware blame separately searches history.",
            "A line's origin commit may be outside first-parent history; the post-tip class deliberately says non-ancestor rather than assuming Aaron authorship."
        ]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), **result["scope"], "aggregate_blamed_lines_by_role": result["aggregate_blamed_lines_by_role"],
                      "aggregate_blamed_lines_by_origin_class": result["aggregate_blamed_lines_by_origin_class"],
                      "aggregate_regions_files_lines_by_role_and_origin_class": detailed_attribution,
                      "prompt_utils": special.get("prompt_utils_extraction")}, indent=2))

if __name__ == "__main__":
    main()
