#!/usr/bin/env python3
"""Parse the Make probe's mapped output (data store 153740) into real rows.

Scenario 6727612 flattens a search_read into two strings, t1 and t2:

    t1 = "n=3 ## date=[2026-06-29|...] ## payment_ref=[SALE VISA|...] ## amount=[30|...]"
    t2 = "id=[75405|...] ## M:statement_line_id=[14171|...] ## V:BNK5/2026/00320"

That is what lands in the data store under `key`. This module turns it back into a
list of dicts so you can total it, group it and diff it instead of eyeballing pipes.

Accepts either the raw JSON array returned by data-store-records_list, or the file
the MCP client saved it to when the response was too big to inline.

    from probe_parse import parse_dump
    rows = parse_dump("dump.txt")                  # -> [{'date':..., 'amount':...}, ...]
    rows = parse_dump("dump.txt", key="my_slot")

    $ python3 probe_parse.py dump.txt --csv out.csv

Fields are returned as strings except that anything fully numeric is coerced to
float, because every caller wants to sum amounts. `M:`/`V:` prefixes are stripped.
Duplicate field names (you often pass the same field in f1..f4 as padding) collapse
to the first occurrence.
"""

import argparse
import csv
import json
import re
import sys

DEFAULT_KEY = "bal1903_byjournal"

_TOKEN = re.compile(r"^(?:M:)?([A-Za-z_][A-Za-z_0-9]*)=\[(.*)\]$", re.S)
_NUMERIC = re.compile(r"^-?\d+(?:\.\d+)?$")


def _load_records(path_or_text):
    """Return the list of data-store records from a file path or a raw string."""
    text = path_or_text
    try:
        with open(path_or_text, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, ValueError):
        pass  # treat the argument as the payload itself
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("no JSON array found in probe dump")
    return json.loads(text[start : end + 1])


def _parse_segment(segment):
    """Parse one 't1'/'t2' string into {field: [values]} plus the row count."""
    fields, count = {}, None
    for token in segment.split(" ## "):
        token = token.strip()
        if not token or token.startswith("V:"):
            continue  # trailing display value, carries no column
        n = re.match(r"^n=(\d+)$", token)
        if n:
            count = int(n.group(1))
            continue
        m = _TOKEN.match(token)
        if not m:
            continue
        name, raw = m.group(1), m.group(2)
        if name in fields:
            continue  # padding repeat
        fields[name] = raw.split("|") if raw else []
    return fields, count


def parse_dump(path_or_text, key=DEFAULT_KEY):
    """Parse the probe result stored under `key` into a list of dicts."""
    records = _load_records(path_or_text)
    matches = [r for r in records if r.get("key") == key]
    if not matches:
        available = ", ".join(sorted(r.get("key", "?") for r in records)[:12])
        raise KeyError(f"key {key!r} not in dump; first keys: {available}")
    data = matches[0].get("data") or {}

    columns, count = {}, None
    for part in ("t1", "t2"):
        if part in data and data[part]:
            fields, n = _parse_segment(data[part])
            count = n if n is not None else count
            for name, values in fields.items():
                columns.setdefault(name, values)

    if not columns:
        return []

    lengths = {len(v) for v in columns.values()}
    if len(lengths) > 1:
        raise ValueError(
            "ragged probe output, columns disagree on length: "
            + ", ".join(f"{k}={len(v)}" for k, v in columns.items())
            + " — a value probably contained a '|' or ' ## '"
        )
    length = lengths.pop()
    if count is not None and count != length:
        print(
            f"warning: probe said n={count} but parsed {length} rows",
            file=sys.stderr,
        )

    rows = []
    for i in range(length):
        row = {}
        for name, values in columns.items():
            v = values[i]
            row[name] = float(v) if _NUMERIC.match(v) else v
        rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dump", help="saved data-store-records_list output, or '-' for stdin")
    ap.add_argument("--key", default=DEFAULT_KEY, help="data store key (default %(default)s)")
    ap.add_argument("--csv", help="write rows to this CSV instead of printing")
    ap.add_argument("--sum", metavar="FIELD", help="also print the total of FIELD")
    args = ap.parse_args()

    payload = sys.stdin.read() if args.dump == "-" else args.dump
    rows = parse_dump(payload, key=args.key)
    if not rows:
        print("no rows", file=sys.stderr)
        return 1

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print(f"{len(rows)} rows -> {args.csv}")
    else:
        for row in rows:
            print(json.dumps(row, ensure_ascii=False))

    if args.sum:
        total = sum(r.get(args.sum, 0) or 0 for r in rows)
        print(f"{len(rows)} rows, sum({args.sum}) = {total:,.2f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
