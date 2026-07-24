#!/usr/bin/env python3
"""Build a deterministic, read-only distributor × SKU replenishment snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
DISTRIBUTORS = [
    ("chirag", "CUSTA000354", "Chirag Enterprises Mumbai", 5, False),
    ("knowtable", "CUSTA000592", "Knowtable Online Services", 9, True),
    ("antize", "CUSTA000927", "Antize Foods", 13, False),
    ("baba", "CUSTA000900", "Baba Lokenath Traders", 17, False),
    ("sustainquest", "CUSTA000907", "Sustainquest", 21, False),
    ("evara", "CUSTA000906", "Evara Enterprises", 25, True),
]
VENDOR_ALIASES = {
    "CHIRAG": "chirag",
    "KNOWTABLE": "knowtable",
    "ANTIZE": "antize",
    "BABA LOKENATH": "baba",
    "SUSTAINQUEST": "sustainquest",
    "EVARA": "evara",
}
ALLOWED_PO_STATUS = {"PENDING", "APPOINTMENT DONE"}
ALLOWED_STATUS = {
    "CONFIRMED", "SCHEDULED", "PENDING", "PENDING_ACKNOWLEDGEMENT",
    "UNSCHEDULED", "PENDING_ASN_CREATION", "ASN_CREATED",
    "PO_ACKNOWLEDGED", "PENDING_GRN",
}
ALLOWED_ITEM_STATUS = {"PENDING", "APPOINTMENT DONE"}
TERMINAL_STATUS = {"CANCELLED", "EXPIRED", "COMPLETED", "FULFILLED"}
PLANNING_COMPANY = "JIVO_MART"
PLANNING_SCHEMA = "JIVO_MART_HANADB"
CALCULATOR_COMPANY = "JIVO_OIL"
CALCULATOR_SCHEMA = "JIVO_OIL_HANADB"
ANTIZE_PHYSICAL_CODES = {
    "CANOLA 1LTR COMBO": "FG0000088",
    "CANOLA OIL 1LTR": "FG0000032",
    "CANOLA OIL 5LTR": "FG0000004",
    "GROUNDNUT 1LTR": "FG0000142",
    "GROUNDNUT OIL 200 ML": "FG0000393",
    "MUSTARD OIL 5LTR": "FG0000011",
    "SUNFLOWER OIL 1LTR": "FG0000081",
    "MUSTARD OIL 1LTR": "FG0000030",
    "EXTRA LIGHT OLIVE OIL 1LTR": "FG0000005",
    "EXTRA LIGHT OLIVE OIL 2 LTR": "FG0000064",
    "EXTRA VIRGIN OLIVE 200MLS": "FG0000164",
    "EXTRA VIRGIN OLIVE OIL 1LTR": "FG0000042",
    "EXTRA VIRGIN OLIVE OIL 5 LTR": "FG0000074",
    "POMACE OLIVE OIL 1LTR": "FG0000028",
    "POMACE OLIVE OIL 2LTR": "FG0000114",
    "POMACE OLIVE OIL 5LTR": "FG0000008",
    "REFIND OIL 15 LTR": "FG0000015",
}


def unwrap(value, *keys):
    for key in keys:
        if isinstance(value, dict) and key in value:
            value = value[key]
    return value


def column_index(cell_ref: str) -> int:
    match = re.match(r"[A-Z]+", cell_ref)
    if not match:
        raise ValueError(f"Invalid XLSX cell reference: {cell_ref}")
    letters = match.group(0)
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value - 1


def read_first_sheet(path: Path) -> list[list[object | None]]:
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{NS}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{NS}t")))
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        rows = []
        for row in root.findall(f".//{NS}row"):
            values = []
            for cell in row.findall(f"{NS}c"):
                index = column_index(cell.attrib["r"])
                while len(values) <= index:
                    values.append(None)
                value_node = cell.find(f"{NS}v")
                inline_node = cell.find(f"{NS}is/{NS}t")
                raw = value_node.text if value_node is not None else None
                cell_type = cell.attrib.get("t")
                if inline_node is not None:
                    value = inline_node.text
                elif raw is None:
                    value = None
                elif cell_type == "s":
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


def explicit_integer(value) -> int | None:
    """Return an evidenced integer; preserve blank cells as missing."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    parsed = float(value)
    if not parsed.is_integer():
        raise ValueError(f"Expected piece quantity to be an integer, got {value!r}")
    return int(parsed)


def identity_key(company_code: str, sap_schema: str, item_code: str) -> tuple[str, str, str]:
    """Company/schema-qualified SAP identity; bare item codes are never join keys."""
    return company_code, sap_schema, item_code


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_uom(value: object) -> str:
    text = str(value or "").upper()
    for old, new in (("LITRES", "LTR"), ("LITRE", "LTR"), ("LITER", "LTR"), ("MLS", "ML")):
        text = text.replace(old, new)
    return re.sub(r"\s+", "", text)


def normalize_item(value: object) -> str:
    text = str(value or "").upper().replace("&", " AND ")
    for old, new in (
        ("LITRES", "L"),
        ("LITRE", "L"),
        ("LTR", "L"),
        ("KACCHI GHANI", "MUSTARD"),
        ("KACHI GHANI", "MUSTARD"),
    ):
        text = text.replace(old, new)
    text = re.sub(
        r"\b(JIVO|OIL|COLD|PRESSED|PRESS|DAILY|COOKING|PACK|BOTTLE|CAN|TIN|CHEMICAL|FREE)\b",
        " ",
        text,
    )
    return " ".join(re.sub(r"[^A-Z0-9]+", " ", text).split())


def normalize_antize(value: object) -> str:
    text = str(value or "").upper()
    text = re.sub(r"JIVO\s+", "", text)
    text = text.replace("COLD PRESSED", "COLD PRESS").replace("CANE", "")
    text = re.sub(r"[()\-]+", " ", text)
    return " ".join(text.split())


def distributor_id(value: object) -> str | None:
    vendor = str(value or "").upper()
    for alias, identifier in VENDOR_ALIASES.items():
        if alias in vendor:
            return identifier
    return None


def qualify_open_po_row(row: dict, as_of_date: date):
    """Return qualified line facts or None for an ineligible/terminal line."""
    if str(row.get("open_close") or "").upper() != "OPEN":
        return None
    po_status = str(row.get("po_status") or "").upper()
    status = str(row.get("status") or "").upper()
    item_status = str(row.get("item_status") or "").upper()
    if po_status in TERMINAL_STATUS or status in TERMINAL_STATUS or item_status in TERMINAL_STATUS:
        return None
    if po_status not in ALLOWED_PO_STATUS or status not in ALLOWED_STATUS or item_status not in ALLOWED_ITEM_STATUS:
        raise ValueError(
            f"Unqualified open PO status for {row.get('po_number')}: "
            f"{po_status}/{status}/{item_status}"
        )
    expiry_text = str(row.get("po_expiry_date") or "")
    if expiry_text and date.fromisoformat(expiry_text[:10]) < as_of_date:
        return None
    order_qty = explicit_integer(row.get("order_qty"))
    delivered_qty = explicit_integer(row.get("delivered_qty"))
    filled_qty = explicit_integer(row.get("filled_qty"))
    if order_qty is None or order_qty < 0:
        raise ValueError(f"Missing/invalid order quantity for {row.get('po_number')}")
    if delivered_qty is None:
        if filled_qty == 0 and item_status == "PENDING":
            delivered_qty = 0
        else:
            raise ValueError(f"Missing delivered quantity for {row.get('po_number')}")
    if filled_qty is None or filled_qty != delivered_qty:
        raise ValueError(f"Delivered/filled quantity mismatch for {row.get('po_number')}")
    if delivered_qty < 0 or delivered_qty > order_qty:
        raise ValueError(f"Invalid delivered quantity for {row.get('po_number')}")
    return {
        "openPieces": order_qty - delivered_qty,
        "orderQty": order_qty,
        "deliveredQty": delivered_qty,
        "expiry": expiry_text,
        "poStatus": po_status,
        "status": status,
        "itemStatus": item_status,
    }


def accept_deduplicated_line(seen: dict, key: tuple, signature: tuple) -> bool:
    """Accept one current line; collapse exact repeats and fail on conflicts."""
    if key not in seen:
        seen[key] = signature
        return True
    if seen[key] == signature:
        return False
    raise ValueError(f"Conflicting duplicate PO-line versions for {key}")


def round_replenishment(
    open_po, usable_stock, confirmed_inbound, stock_qualified, inbound_qualified, case_pack
):
    if open_po <= 0:
        return 0, 0, "no-demand", None
    if not stock_qualified or usable_stock is None:
        return None, None, "blocked", "Distributor stock is not qualified at SKU level."
    if not inbound_qualified or confirmed_inbound is None:
        return None, None, "blocked", "Confirmed inbound evidence is missing; zero cannot be assumed."
    raw = max(0, open_po - max(0, usable_stock) - max(0, confirmed_inbound))
    if raw == 0:
        return 0, 0, "covered", None
    if not case_pack:
        return None, None, "blocked", "Case-pack evidence is missing; no exact quantity is shown."
    return raw, math.ceil(raw / case_pack) * case_pack, "replenish", None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--master-po", required=True, type=Path)
    parser.add_argument("--stock-workbook", required=True, type=Path)
    antize_source = parser.add_mutually_exclusive_group(required=True)
    antize_source.add_argument("--antize-workbook", type=Path)
    antize_source.add_argument("--antize-physical-json", type=Path)
    parser.add_argument("--calculator-items", required=True, type=Path)
    parser.add_argument("--master-products", required=True, type=Path)
    parser.add_argument("--planning-as-of", required=True)
    parser.add_argument("--stock-as-of", required=True)
    parser.add_argument("--max-stock-age-days", type=int, default=2)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    as_of_date = date.fromisoformat(args.planning_as_of[:10])
    stock_as_of_date = date.fromisoformat(args.stock_as_of[:10])
    stock_age_days = (as_of_date - stock_as_of_date).days
    if stock_age_days < 0:
        raise ValueError("Stock as-of date cannot be later than the PO snapshot")
    stock_is_fresh = stock_age_days <= args.max_stock_age_days

    stock_rows = read_first_sheet(args.stock_workbook)
    catalog = {}
    stock = defaultdict(dict)
    for row in stock_rows[2:]:
        if not row or not row[0]:
            continue
        code = str(row[0])
        qualified_key = identity_key(PLANNING_COMPANY, PLANNING_SCHEMA, code)
        catalog[qualified_key] = {
            "sapCode": code,
            "companyCode": PLANNING_COMPANY,
            "sapSchema": PLANNING_SCHEMA,
            "skuName": str(row[1]),
            "category": str(row[2]),
            "subCategory": str(row[3]),
            "itemHead": str(row[4]),
            "catalogSource": "DIS. STOCK REPORT.xlsx",
        }
        for identifier, _, _, offset, opening_missing in DISTRIBUTORS:
            raw_cells = [row[offset + i] if len(row) > offset + i else None for i in range(4)]
            evidenced = [explicit_integer(value) for value in raw_cells]
            opening, billing, grn, balance = [value if value is not None else 0 for value in evidenced]
            if all(value is not None for value in evidenced) and balance != opening + billing - grn:
                raise ValueError(
                    f"Tracker equation mismatch for {identifier}:{code}: "
                    f"{balance} != {opening} + {billing} - {grn}"
                )
            stock[identifier][qualified_key] = {
                "openingPieces": opening if evidenced[0] is not None else None,
                "billingPieces": billing if evidenced[1] is not None else None,
                "grnPieces": grn if evidenced[2] is not None else None,
                "trackerBalancePieces": balance if evidenced[3] is not None else None,
                "cellsQualified": all(value is not None for value in evidenced),
                "openingMissing": opening_missing or evidenced[0] is None,
            }

    antize_physical = defaultdict(int)
    if args.antize_workbook:
        physical_rows = read_first_sheet(args.antize_workbook)
        antize_source_path = args.antize_workbook
    else:
        assert args.antize_physical_json is not None
        physical_rows = json.loads(args.antize_physical_json.read_text())
        antize_source_path = args.antize_physical_json
    for row in physical_rows:
        if not row or not row[0] or str(row[0]).upper().startswith("GRAND TOTAL"):
            continue
        raw_quantity = row[4] if len(row) > 4 else 0
        if not isinstance(raw_quantity, (int, float)):
            continue
        quantity = explicit_integer(raw_quantity)
        assert quantity is not None
        if quantity == 0:
            continue
        normalized = normalize_antize(row[0])
        code = None
        for alias, candidate in ANTIZE_PHYSICAL_CODES.items():
            if alias in normalized:
                code = candidate
                break
        if not code:
            raise ValueError(f"Unmapped Antize physical item: {row[0]}")
        antize_physical[code] += quantity
    if sum(antize_physical.values()) != 42322:
        raise ValueError("Antize physical opening does not reconcile to 42,322 pieces")

    stock_catalog_codes = set(catalog)
    calculator = unwrap(json.loads(args.calculator_items.read_text()), "results", "items")
    packs = defaultdict(set)
    for item in calculator:
        pack = explicit_integer(item.get("pcs_per_box"))
        if item.get("code") and pack is not None and pack > 0:
            packs[identity_key(CALCULATOR_COMPANY, CALCULATOR_SCHEMA, str(item["code"]))].add(pack)

    master_products = unwrap(
        json.loads(args.master_products.read_text()), "results", "results"
    )
    platform_map = {}
    platform_pack_sets = defaultdict(set)
    for product in master_products:
        key = (str(product.get("format") or "").upper(), str(product.get("format_sku_code")))
        identity = (
            str(product.get("sku_sap_code") or ""),
            normalize_uom(product.get("per_unit")),
            normalize_uom(product.get("uom")),
            explicit_integer(product.get("case_pack")),
        )
        if key in platform_map:
            existing = platform_map[key]
            existing_identity = (
                str(existing.get("sku_sap_code") or ""),
                normalize_uom(existing.get("per_unit")),
                normalize_uom(existing.get("uom")),
                explicit_integer(existing.get("case_pack")),
            )
            if identity != existing_identity:
                raise ValueError(f"Conflicting platform identity mapping for {key}")
        platform_map[key] = product
        platform_pack = explicit_integer(product.get("case_pack"))
        if product.get("sku_sap_code") and platform_pack is not None and platform_pack > 0:
            platform_pack_sets[identity_key(PLANNING_COMPANY, PLANNING_SCHEMA, str(product["sku_sap_code"]))].add(
                platform_pack
            )

    company_qualified_keys = stock_catalog_codes | set(packs)
    master_po = unwrap(json.loads(args.master_po.read_text()), "results", "data")
    demand = defaultdict(lambda: {
        "pieces": 0, "poNumbers": set(), "platforms": set(), "locations": set(),
        "nextExpiry": None, "mappingSources": set(), "baseUoms": set(),
        "planningUoms": set(), "perUnits": set(),
    })
    unresolved = defaultdict(lambda: {"pieces": 0, "poNumbers": set(), "locations": set(), "nextExpiry": None, "skuName": None, "blockers": set()})
    seen_lines = {}

    for row in master_po:
        identifier = distributor_id(row.get("vendor_new") or row.get("vendor_name"))
        if not identifier:
            continue
        qualified = qualify_open_po_row(row, as_of_date)
        if qualified is None:
            continue
        expiry_text = qualified["expiry"]
        open_pieces = qualified["openPieces"]
        if open_pieces == 0:
            continue
        platform_key = (str(row.get("format") or "").upper(), str(row.get("sku_code")))
        master_product = platform_map.get(platform_key)
        code = None
        source = None
        identity_blocker = None
        master_unit = ""
        master_uom = ""
        po_unit = ""
        candidate_key = None
        if not master_product or not master_product.get("sku_sap_code"):
            identity_blocker = "No exact platform-SKU to SAP-SKU mapping."
        else:
            candidate_code = str(master_product["sku_sap_code"])
            candidate_key = identity_key(PLANNING_COMPANY, PLANNING_SCHEMA, candidate_code)
            master_unit = normalize_uom(master_product.get("per_unit"))
            master_uom = normalize_uom(master_product.get("uom"))
            po_unit = normalize_uom(row.get("unit_of_measure"))
            if candidate_key not in company_qualified_keys:
                identity_blocker = "SAP SKU is not qualified by the company stock/calculator masters."
            elif not master_unit or not master_uom:
                identity_blocker = "Mapped SKU is missing base-UOM evidence."
            elif not po_unit:
                identity_blocker = "PO UOM is missing; order quantity cannot be qualified as pieces."
            elif po_unit != master_unit:
                identity_blocker = "PO UOM conflicts with the exact product-master UOM."
            else:
                code = candidate_code
                source = "JIVO_MART-qualified exact platform SKU mapping"

        line_key = (
            identifier,
            str(row.get("format") or ""),
            str(row.get("po_number") or ""),
            str(row.get("sku_code") or ""),
            str(row.get("location") or ""),
        )
        line_signature = (
            qualified["orderQty"], qualified["deliveredQty"], expiry_text,
            qualified["poStatus"], qualified["status"], qualified["itemStatus"],
            code, identity_blocker,
        )
        if not accept_deduplicated_line(seen_lines, line_key, line_signature):
            continue

        if code:
            assert master_product is not None
            assert candidate_key is not None
            if candidate_key not in catalog:
                catalog[candidate_key] = {
                    "sapCode": code,
                    "companyCode": PLANNING_COMPANY,
                    "sapSchema": PLANNING_SCHEMA,
                    "skuName": str(master_product.get("item") or master_product.get("sku_sap_name") or row.get("sku_name")),
                    "category": str(master_product.get("variety") or row.get("category") or "UNCLASSIFIED"),
                    "subCategory": str(row.get("sub_category") or "UNCLASSIFIED"),
                    "itemHead": str(master_product.get("item_head") or row.get("item_head") or "UNCLASSIFIED"),
                    "catalogSource": "ecom master products",
                }
            catalog[candidate_key].update({
                "companyCode": PLANNING_COMPANY,
                "sapSchema": PLANNING_SCHEMA,
                "baseUom": master_uom,
                "perUnit": master_unit,
            })
            target = demand[(identifier, candidate_key)]
            target["pieces"] += open_pieces
            target["poNumbers"].add(str(row.get("po_number")))
            target["platforms"].add(str(row.get("format") or "UNKNOWN"))
            target["locations"].add(str(row.get("location") or "UNKNOWN"))
            target["mappingSources"].add(source)
            target["baseUoms"].add(master_uom)
            target["planningUoms"].add(po_unit)
            target["perUnits"].add(master_unit)
            if expiry_text and (target["nextExpiry"] is None or expiry_text < target["nextExpiry"]):
                target["nextExpiry"] = expiry_text
        else:
            key = (identifier, str(row.get("format") or "UNKNOWN"), str(row.get("sku_code") or "UNKNOWN"))
            target = unresolved[key]
            target["pieces"] += open_pieces
            target["poNumbers"].add(str(row.get("po_number")))
            target["locations"].add(str(row.get("location") or "UNKNOWN"))
            target["skuName"] = str(row.get("item") or row.get("sku_name") or "Unmapped PO SKU")
            target["blockers"].add(identity_blocker or "Identity evidence is incomplete.")
            if expiry_text and (target["nextExpiry"] is None or expiry_text < target["nextExpiry"]):
                target["nextExpiry"] = expiry_text

    rows = []
    for identifier, customer_code, distributor_name, *_ in DISTRIBUTORS:
        for qualified_key in sorted(catalog):
            company_code, sap_schema, code = qualified_key
            sku = catalog[qualified_key]
            tracker = stock[identifier].get(qualified_key)
            evidenced_stock = None
            if identifier == "antize" and code in antize_physical:
                evidenced_stock = antize_physical[code]
                usable = antize_physical[code]
                stock_qualified = stock_is_fresh
                stock_status = "qualified-physical-count" if stock_is_fresh else "stale-physical-count"
                if not stock_is_fresh:
                    usable = None
            elif identifier == "antize":
                usable = None
                stock_qualified = False
                stock_status = "missing-physical-count"
            elif not tracker:
                usable = None
                stock_qualified = False
                stock_status = "missing-stock-row"
            elif tracker["openingMissing"] or not tracker["cellsQualified"]:
                usable = None
                stock_qualified = False
                stock_status = "missing-opening"
            elif tracker["openingPieces"] < 0 or tracker["trackerBalancePieces"] < 0:
                evidenced_stock = tracker["trackerBalancePieces"]
                usable = None
                stock_qualified = False
                stock_status = "reconciliation-exception"
            elif not stock_is_fresh:
                evidenced_stock = tracker["trackerBalancePieces"]
                usable = None
                stock_qualified = False
                stock_status = "stale-tracker-balance"
            else:
                evidenced_stock = tracker["trackerBalancePieces"]
                usable = tracker["trackerBalancePieces"]
                stock_qualified = True
                stock_status = "qualified-tracker-balance"
            po = demand[(identifier, qualified_key)]
            calculator_pack_values = packs.get(qualified_key, set())
            platform_pack_values = platform_pack_sets.get(qualified_key, set())
            combined_pack_values = calculator_pack_values | platform_pack_values
            case_pack = next(iter(combined_pack_values)) if len(combined_pack_values) == 1 else None
            if case_pack and calculator_pack_values:
                case_pack_source = "Control Panel calculator items"
            elif case_pack:
                case_pack_source = "Consistent exact ecom product mappings"
            else:
                case_pack_source = None
            confirmed_inbound = None
            inbound_qualified = False
            raw, recommended, status, blocker = round_replenishment(
                po["pieces"], usable, confirmed_inbound, stock_qualified,
                inbound_qualified, case_pack
            )
            if po["pieces"] > 0 and stock_status.startswith("stale-"):
                blocker = (
                    f"Stock evidence is {stock_age_days} days old; maximum allowed age is "
                    f"{args.max_stock_age_days} days."
                )
            rows.append({
                "id": f"{identifier}:{company_code}:{sap_schema}:{code}",
                "distributorId": identifier,
                "distributorCode": customer_code,
                "distributorName": distributor_name,
                **sku,
                "openPoPieces": po["pieces"],
                "openPoCount": len(po["poNumbers"]),
                "poNumbers": sorted(po["poNumbers"]),
                "platforms": sorted(po["platforms"]),
                "locations": sorted(po["locations"]),
                "nextPoExpiry": po["nextExpiry"],
                "poMappingSources": sorted(po["mappingSources"]),
                "companyCode": PLANNING_COMPANY,
                "sapSchema": PLANNING_SCHEMA,
                "baseUom": next(iter(po["baseUoms"])) if len(po["baseUoms"]) == 1 else sku.get("baseUom"),
                "perUnit": next(iter(po["perUnits"])) if len(po["perUnits"]) == 1 else sku.get("perUnit"),
                "planningUom": next(iter(po["planningUoms"])) if len(po["planningUoms"]) == 1 else None,
                "planningCutoff": args.planning_as_of,
                "openingPieces": tracker["openingPieces"] if tracker else None,
                "billingPieces": tracker["billingPieces"] if tracker else None,
                "grnPieces": tracker["grnPieces"] if tracker else None,
                "trackerBalancePieces": tracker["trackerBalancePieces"] if tracker else None,
                "evidencedStockPieces": evidenced_stock,
                "usableStockPieces": usable,
                "stockQualified": stock_qualified,
                "stockStatus": stock_status,
                "stockAsOf": args.stock_as_of if tracker or identifier == "antize" else None,
                "stockAgeDays": stock_age_days if tracker or identifier == "antize" else None,
                "confirmedInboundPieces": None,
                "confirmedInboundIncludedPieces": None,
                "inboundQualified": inbound_qualified,
                "casePack": case_pack,
                "casePackSource": case_pack_source,
                "casePackStatus": "qualified" if case_pack else ("conflict" if len(combined_pack_values) > 1 else "missing"),
                "rawNeedPieces": raw,
                "recommendedPieces": recommended,
                "status": status,
                "blocker": blocker,
            })

    for (identifier, platform, sku_code), value in unresolved.items():
        distributor = next(item for item in DISTRIBUTORS if item[0] == identifier)
        rows.append({
            "id": f"{identifier}:unmapped:{platform}:{sku_code}",
            "distributorId": identifier,
            "distributorCode": distributor[1],
            "distributorName": distributor[2],
            "sapCode": None,
            "companyCode": None,
            "sapSchema": None,
            "baseUom": None,
            "perUnit": None,
            "planningUom": None,
            "skuName": value["skuName"],
            "category": "UNMAPPED",
            "subCategory": "UNMAPPED",
            "itemHead": "UNMAPPED",
            "catalogSource": "unmapped platform PO identity",
            "openPoPieces": value["pieces"],
            "openPoCount": len(value["poNumbers"]),
            "poNumbers": sorted(value["poNumbers"]),
            "platforms": [platform],
            "locations": sorted(value["locations"]),
            "nextPoExpiry": value["nextExpiry"],
            "poMappingSources": [],
            "planningCutoff": args.planning_as_of,
            "openingPieces": None,
            "billingPieces": None,
            "grnPieces": None,
            "trackerBalancePieces": None,
            "evidencedStockPieces": None,
            "usableStockPieces": None,
            "stockQualified": False,
            "stockStatus": "identity-blocked",
            "stockAsOf": None,
            "stockAgeDays": None,
            "confirmedInboundPieces": None,
            "confirmedInboundIncludedPieces": None,
            "inboundQualified": False,
            "casePack": None,
            "casePackSource": None,
            "casePackStatus": "missing",
            "rawNeedPieces": None,
            "recommendedPieces": None,
            "status": "identity-blocked",
            "blocker": "; ".join(sorted(value["blockers"])),
        })

    priority = {"identity-blocked": 0, "blocked": 1, "review": 2, "replenish": 3, "covered": 4, "no-demand": 5}
    rows.sort(key=lambda row: (priority.get(row["status"], 9), -(row["openPoPieces"] or 0), row["distributorName"], row["skuName"]))
    summary = {
        "distributors": len(DISTRIBUTORS),
        "canonicalSkus": len(catalog),
        "trackedRows": len(rows),
        "openPoPieces": sum(row["openPoPieces"] for row in rows),
        "mappedOpenPoPieces": sum(row["openPoPieces"] for row in rows if row["sapCode"]),
        "blockedOpenPoPieces": sum(row["openPoPieces"] for row in rows if row["recommendedPieces"] is None),
        "identityBlockedOpenPoPieces": sum(row["openPoPieces"] for row in rows if row["status"] == "identity-blocked"),
        "mappedEvidenceBlockedOpenPoPieces": sum(row["openPoPieces"] for row in rows if row["sapCode"] and row["recommendedPieces"] is None),
        "staleStockBlockedOpenPoPieces": sum(row["openPoPieces"] for row in rows if row["stockStatus"].startswith("stale-")),
        "recommendedPieces": sum(row["recommendedPieces"] or 0 for row in rows),
        "rowsToReplenish": sum(row["status"] == "replenish" for row in rows),
        "blockedRows": sum(row["status"] in {"blocked", "identity-blocked"} for row in rows),
    }
    output = {
        "planningCutoff": args.planning_as_of,
        "scope": "Six distributors × union of stock-tracker and open-PO SKUs",
        "policy": {
            "demand": "PO-only",
            "quantityUnit": "Pieces; exact platform identity and UOM are required, and delivered_qty must equal filled_qty.",
            "skuUniverse": "Union of distributor stock workbook SKUs and exact-mapped open-PO SKUs; unresolved PO identities remain separate blocker rows.",
            "formula": "max(0, open PO balance - qualified usable stock - confirmed inbound), rounded to qualified case pack",
            "buffer": "Display-only; zero until separately approved",
            "inTransit": "Only confirmed inbound may offset demand; no confirmed-inbound feed is connected in this snapshot",
            "planningCompany": PLANNING_COMPANY,
            "planningSchema": PLANNING_SCHEMA,
            "maxStockAgeDays": args.max_stock_age_days,
            "lifecycle": ["Required", "Factory-ready", "Transferred", "Platform GRN", "Closed"],
        },
        "sources": [
            {"name": "ecom master_po", "asOf": None, "mode": "read-only export marked live by connector; source timestamp unavailable", "sha256": file_sha256(args.master_po)},
            {"name": "ecom master products", "companyCode": PLANNING_COMPANY, "sapSchema": PLANNING_SCHEMA, "asOf": None, "mode": "read-only export marked live by connector; source timestamp unavailable", "sha256": file_sha256(args.master_products)},
            {"name": "DIS. STOCK REPORT.xlsx", "companyCode": PLANNING_COMPANY, "sapSchema": PLANNING_SCHEMA, "asOf": args.stock_as_of, "formula": "BAL = SOH + Billing - GRN", "sha256": file_sha256(args.stock_workbook)},
            {"name": "Antize Jivo-16 physical count", "companyCode": PLANNING_COMPANY, "sapSchema": PLANNING_SCHEMA, "asOf": args.stock_as_of, "acceptedPieces": 42322, "sha256": file_sha256(antize_source_path)},
            {"name": "Control Panel calculator items", "companyCode": CALCULATOR_COMPANY, "sapSchema": CALCULATOR_SCHEMA, "asOf": None, "mode": "read-only export marked live by connector; excluded from JIVO_MART pack qualification", "sha256": file_sha256(args.calculator_items)},
        ],
        "summary": summary,
        "distributors": [
            {"id": item[0], "code": item[1], "name": item[2], "openingMissing": item[4]}
            for item in DISTRIBUTORS
        ],
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
