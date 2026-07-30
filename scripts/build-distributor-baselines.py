#!/usr/bin/env python3
"""Build qualified distributor physical-stock baselines from shared workbooks.

This script reads local evidence only and writes a planner-owned JSON projection.
It never calls or mutates a JIVO source system.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

DISTRIBUTORS = {
    "antize": {"code": "CUSTA000927", "name": "Antize Foods", "asOf": "2026-07-28"},
    "chirag": {"code": "CUSTA000354", "name": "Chirag Enterprises Mumbai", "asOf": "2026-07-29"},
    "baba": {"code": "CUSTA000900", "name": "Baba Lokenath Traders", "asOf": "2026-07-30"},
}

ANTIZE_CODES = {
    "CANOLA OIL 1LTR COMBO": "FG0000088",
    "CANOLA OIL 1LTR": "FG0000032",
    "CANOLA OIL 5LTR": "FG0000004",
    "GROUNDNUT 1LTR": "FG0000142",
    "GROUNDNUT OIL 200 ML": "FG0000393",
    "MUSTARD OIL 5LTR": "FG0000011",
    "SUNFLOWER OIL 1LTR": "FG0000081",
    "MUSTARD OIL 1LTR": "FG0000030",
    "EXTRA LIGHT OLIVE OIL 1LTR": "FG0000005",
    "EXTRA LIGHT OLIVE OIL 2 LTR": "FG0000064",
    "EXTRA LIGHT OLIVE OIL 5 LTR": "FG0000009",
    "EXTRA VIRGIN OLIVE 200MLS": "FG0000164",
    "EXTRA VIRGIN OLIVE OIL 1LTR": "FG0000042",
    "EXTRA VIRGIN OLIVE OIL 5 LTR": "FG0000074",
    "POMACE OLIVE OIL 1LTR": "FG0000028",
    "POMACE OLIVE OIL 2LTR": "FG0000114",
    "POMACE OLIVE OIL 5LTR": "FG0000008",
    "REFIND OIL 15 LTR": "FG0000015",
}

CHIRAG_CODES = {
    "12379": "FG0000258", "12403": "FG0000251", "12380": "FG0000260",
    "12462": "FG0000363", "11071": "FG0000276", "12457": "FG0000375",
    "11438": "FG0000293", "12454": "FG0000309", "12382": "FG0000280",
    "12110": "FG0000262", "12455": "FG0000279", "12410": "FG0000250",
    "11516": "FG0000244", "12453": "FG0000266", "12381": "FG0000281",
    "12109": "FG0000263", "12402": "FG0000252",
    "12439": "FG0000018", "12426": "FG0000088", "12420": "FG0000032",
    "12415": "FG0000004", "12443": "FG0000223", "12416": "FG0000005",
    "12423": "FG0000064", "12418": "FG0000009", "12430": "FG0000149",
    "12427": "FG0000128", "12428": "FG0000142", "12464": "FG0000393",
    "12429": "FG0000143", "12412": "FG0000030", "12441": "FG0000302",
    "12411": "FG0000011", "12419": "FG0000028", "12434": "FG0000114",
    "12417": "FG0000008", "12436": "FG0000227", "12435": "FG0000230",
    "12468": "FG0000376", "12437": "FG0000228", "12438": "FG0000229",
    "12432": "FG0000193", "12414": "FG0000192", "12425": "FG0000081",
    "12422": "FG0000053", "12440": "FG0000303", "12421": "FG0000042",
    "12472": "FG0000164", "12433": "FG0000112", "12424": "FG0000074",
    "12467": "FG0000328", "12413": "FG0000150", "12431": "FG0000151",
}

BABA_CODES = {
    "JIVO GOLD (1LTRX 20PCS)": "FG0000149",
    "JIVO GOLD (5LTR X 4PCS)": "FG0000128",
    "JIVO COLD PRESS CANOLA OIL (1LTRX20PCS)": "FG0000032",
    "JIVO COLD PRESS CANOLA OIL (1LTRX24 PCS)": "FG0000421",
    "JIVO COLD PRESS CANOLA OIL (5LTRX4PCS)": "FG0000004",
    "JIVO COLD PRESS GROUNDNUT OIL (16X1LTR)": "FG0000142",
    "JIVO COLD PRESS GROUNDNUT OIL (4X5LTR)": "FG0000143",
    "JIVO MUSTARD KACHHI GHANI (12X1LTR) POUCH": "FG0000106",
    "JIVO MUSTARD KACHHI GHANI (20X1LTR)": "FG0000030",
    "JIVO MUSTARD KACHHI GHANI (4X5LTR)": "FG0000011",
    "JIVO YELLOW MUSTARD (1LTRX20PCS)": "FG0000328",
    "JIVO EXTRA LIGHT OLIVE (16X1LTR)": "FG0000005",
    "JIVO EXTRA LIGHT OLIVE (2LTR X 10PCS)": "FG0000064",
    "JIVO EXTRA LIGHT OLIVE (5LTRX 4PCS)": "FG0000009",
    "JIVO EXTRA VIRGIN OLIVE OIL (16X1LTR)": "FG0000042",
    "JIVO EXTRA VIRGIN OLIVE OIL (5LTRX4PCS)TIN IMPORTED": "FG0000074",
    "JIVO SO OLIVE OIL(1LTR X16PCS)": "FG0000228",
    "POMACE OLIVE OIL (16X1LTR)": "FG0000028",
    "POMACE OLIVE OIL (2LTR X 10PCS)": "FG0000114",
    "POMACE OLIVE OIL (5LTRX4PCS)": "FG0000008",
    "SANO POMACE OLIVE OIL (16X1LTR)": "FG0000150",
    "SANO POMACE OLIVE OIL (5 LTR X4PCS)": "FG0000151",
    "JIVO RICE BRAN OIL (16X1LTR)": "FG0000227",
    "JIVO RICE BRAN OIL (5LTRX4PCS)": "FG0000230",
    "JIVO SESAME OIL (20X1LTR)": "FG0000376",
    "JIVO COLD PRESS SOYABEAN OIL(1LTRX12PCS)": "FG0000109",
    "JIVO COLD PRESS SUNFLOWER (20X1LTR)": "FG0000081",
    "JIVO COLD PRESS SUNFLOWER (24X1LTR)": "FG0000402",
}


def column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref)
    if not letters:
        raise ValueError(f"Invalid XLSX cell reference: {cell_ref}")
    value = 0
    for letter in letters.group(0):
        value = value * 26 + ord(letter) - 64
    return value - 1


def read_first_sheet(path: Path) -> list[list[Any]]:
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{NS}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{NS}t")))
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows: list[list[Any]] = []
        for row in root.findall(f".//{NS}row"):
            values: list[Any] = []
            for cell in row.findall(f"{NS}c"):
                index = column_index(cell.attrib["r"])
                while len(values) <= index:
                    values.append(None)
                value_node = cell.find(f"{NS}v")
                inline_node = cell.find(f"{NS}is/{NS}t")
                raw = value_node.text if value_node is not None else None
                if inline_node is not None:
                    value: Any = inline_node.text
                elif raw is None:
                    value = None
                elif cell.attrib.get("t") == "s":
                    value = shared[int(raw)]
                else:
                    try:
                        number = float(raw)
                        value = int(number) if number.is_integer() else number
                    except ValueError:
                        value = raw
                values[index] = value
            rows.append(values)
        return rows


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_antize(value: Any) -> str:
    text = str(value or "").upper()
    text = re.sub(r"JIVO\s+", "", text)
    text = text.replace("COLD PRESSED", "COLD PRESS").replace("CANE", "")
    text = re.sub(r"[()\-]+", " ", text)
    return " ".join(text.split())


def row_record(code: str, item_name: str, reported: int) -> dict[str, Any]:
    return {
        "sapCode": code,
        "itemName": item_name,
        "reportedOpeningPieces": reported,
        "usableOpeningPieces": max(0, reported),
        "openingStatus": "negative-report-exception" if reported < 0 else "qualified",
    }


def parse_antize(path: Path) -> list[dict[str, Any]]:
    parsed: dict[str, dict[str, Any]] = {}
    for row in read_first_sheet(path):
        if not row or not row[0]:
            continue
        normalized = normalize_antize(row[0])
        code = next((candidate for alias, candidate in ANTIZE_CODES.items() if alias in normalized), None)
        if not code:
            continue
        quantity = int(row[5]) if len(row) > 5 and isinstance(row[5], (int, float)) else 0
        record = parsed.setdefault(code, row_record(code, str(row[0]), 0))
        record["reportedOpeningPieces"] += quantity
        record["usableOpeningPieces"] += max(0, quantity)
    rows = list(parsed.values())
    if sum(row["reportedOpeningPieces"] for row in rows) != 26457:
        raise ValueError("Antize report does not reconcile to 26,457 pieces")
    return rows


def parse_chirag(path: Path) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for row in read_first_sheet(path):
        if not row or str(row[0]) not in CHIRAG_CODES:
            continue
        reported = int(row[3] or 0) if len(row) > 3 else 0
        parsed.append(row_record(CHIRAG_CODES[str(row[0])], str(row[1]), reported))
    if len(parsed) != len(CHIRAG_CODES):
        raise ValueError(f"Expected {len(CHIRAG_CODES)} Chirag mapped rows, found {len(parsed)}")
    if sum(row["reportedOpeningPieces"] for row in parsed) != 28051:
        raise ValueError("Chirag oil and beverage rows do not reconcile to 28,051 net pieces")
    return parsed


def parse_baba(path: Path) -> list[dict[str, Any]]:
    parsed: list[dict[str, Any]] = []
    for row in read_first_sheet(path):
        if not row or str(row[0]) not in BABA_CODES:
            continue
        parsed.append(row_record(BABA_CODES[str(row[0])], str(row[0]), int(row[1])))
    if len(parsed) != len(BABA_CODES):
        raise ValueError(f"Expected {len(BABA_CODES)} Baba rows, found {len(parsed)}")
    if sum(row["reportedOpeningPieces"] for row in parsed) != 31647:
        raise ValueError("Baba report does not reconcile to 31,647 pieces")
    return parsed


def distributor_record(identifier: str, source: Path, rows: list[dict[str, Any]]) -> dict[str, Any]:
    meta = DISTRIBUTORS[identifier]
    return {
        "id": identifier,
        **meta,
        "sourceFile": source.name,
        "sourceSha256": sha256(source),
        "completeReport": True,
        "reportedOpeningPieces": sum(row["reportedOpeningPieces"] for row in rows),
        "usableOpeningPieces": sum(row["usableOpeningPieces"] for row in rows),
        "negativeOpeningSkus": sum(row["reportedOpeningPieces"] < 0 for row in rows),
        "rows": sorted(rows, key=lambda row: row["sapCode"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--antize", required=True, type=Path)
    parser.add_argument("--chirag", required=True, type=Path)
    parser.add_argument("--baba", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "formula": "Projected distributor stock = qualified physical opening + SAP billing after cutoff - mapped platform GRN after cutoff",
        "distributors": [
            distributor_record("antize", args.antize, parse_antize(args.antize)),
            distributor_record("chirag", args.chirag, parse_chirag(args.chirag)),
            distributor_record("baba", args.baba, parse_baba(args.baba)),
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n")


if __name__ == "__main__":
    main()
