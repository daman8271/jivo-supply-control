#!/usr/bin/env python3
"""Live-data and planner-state gateway for the Jivo Supply Control preview.

The gateway keeps JIVO credentials server-side. It serves live GET projections at
/api/live/*, stores planner-owned MSL values, and reverse-proxies the Vinext
application for every other route. It never calls a mutating JIVO source-system
endpoint.
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".config/jivo-ecom-pp-cli/config.toml"
WAREHOUSE_CODE = "GP-FGM"
WAREHOUSE_NAME = "GUPTA FINISHED GOODS MART"
CACHE_SECONDS = 30
DISTRIBUTOR_CACHE_SECONDS = 300
BASELINES_PATH = Path(__file__).parents[1] / "app/data/distributor-baselines.json"
MSL_STORE_PATH = Path("/var/lib/jivo-supply-control/own-inventory-msl.json")
TRACKED_DISTRIBUTORS = {
    "antize": ("CUSTA000927", "ANTIZE"),
    "chirag": ("CUSTA000354", "CHIRAG"),
    "baba": ("CUSTA000900", "BABA LOKENATH"),
}
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"expires": 0.0, "payload": None}
_distributor_cache: dict[str, Any] = {"expires": 0.0, "payload": None}
_msl_lock = threading.Lock()


def read_msl_store(path: Path = MSL_STORE_PATH) -> dict[str, Any]:
    if not path.exists():
        return {"status": "ok", "unit": "pieces", "updatedAt": None, "values": {}}
    payload = json.loads(path.read_text(encoding="utf-8"))
    values = payload.get("values")
    if not isinstance(values, dict):
        raise ValueError("MSL store values must be an object")
    clean_values: dict[str, int] = {}
    for sap_code, pieces in values.items():
        if not re.fullmatch(r"[A-Z0-9_-]{1,64}", str(sap_code)):
            raise ValueError("MSL store contains an invalid SAP code")
        if (
            isinstance(pieces, bool)
            or not isinstance(pieces, int)
            or pieces < 0
            or pieces > 1_000_000_000
        ):
            raise ValueError("MSL store contains an invalid pieces value")
        clean_values[str(sap_code)] = pieces
    return {
        "status": "ok",
        "unit": "pieces",
        "updatedAt": payload.get("updatedAt"),
        "values": clean_values,
    }


def update_msl_value(
    sap_code: str,
    pieces: int | None,
    path: Path = MSL_STORE_PATH,
) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Z0-9_-]{1,64}", sap_code):
        raise ValueError("Invalid SAP code")
    if pieces is not None and (
        isinstance(pieces, bool)
        or not isinstance(pieces, int)
        or pieces < 0
        or pieces > 1_000_000_000
    ):
        raise ValueError("MSL pieces must be a whole number from 0 to 1,000,000,000")
    with _msl_lock:
        payload = read_msl_store(path)
        values = dict(payload["values"])
        if pieces is None:
            values.pop(sap_code, None)
        else:
            values[sap_code] = pieces
        result = {
            "status": "ok",
            "unit": "pieces",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "values": values,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
        temporary.write_text(
            json.dumps(result, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
        return result


def load_ecom_config(path: Path = CONFIG_PATH) -> tuple[str, str]:
    with path.open("rb") as handle:
        config = tomllib.load(handle)
    base_url = str(config.get("base_url") or "https://ecom.jivo.in").rstrip("/")
    token = str(config.get("ecom_token") or config.get("access_token") or "")
    if not token:
        raise RuntimeError(f"No Ecom access token is configured in {path}")
    return base_url, token


def fetch_json(path: str, *, timeout: int = 30) -> dict[str, Any]:
    base_url, token = load_ecom_config()
    request = urllib.request.Request(
        base_url + path,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "Jivo-Supply-Control-Live-Gateway/1.0",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def litre_factor(item_name: str) -> float:
    name = item_name.upper()
    millilitres = re.search(r"(?:^|\s)(\d+(?:\.\d+)?)\s*M(?:L|LS)\b", name)
    if millilitres:
        return float(millilitres.group(1)) / 1000
    litres = re.search(r"(?:^|\s)(\d+(?:\.\d+)?)\s*LTR\b", name)
    if litres:
        return float(litres.group(1))
    return 0.0


def classify_item(item_name: str) -> tuple[str, str]:
    name = item_name.upper()
    categories = (
        ("GROUNDNUT", "GROUNDNUT"),
        ("MUSTARD", "MUSTARD"),
        ("SUNFLOWER", "SUNFLOWER"),
        ("SOYABEAN", "SOYABEAN"),
        ("RICE BRAN", "RICE BRAN"),
        ("CANOLA", "CANOLA"),
        ("COLD PRESS", "CANOLA"),
        ("SESAME", "SESAME"),
        ("OLIVE", "OLIVE"),
        ("GOLD", "GOLD"),
    )
    category = next((label for needle, label in categories if needle in name), "OTHER")
    commodity = {"MUSTARD", "SUNFLOWER", "SOYABEAN", "RICE BRAN", "GOLD"}
    item_head = "COMMODITY" if category in commodity else "PREMIUM" if category != "OTHER" else "OTHER"
    return item_head, category


def inventory_status(on_hand: float, committed: float, available: float) -> str:
    if available < 0:
        return "Critical"
    if on_hand > 0 and available <= max(10.0, committed * 0.25):
        return "Low"
    return "Healthy"


def build_inventory_payload(
    stock_response: dict[str, Any],
    items_response: dict[str, Any],
    observed_at: str | None = None,
) -> dict[str, Any]:
    stock_rows = stock_response.get("data") or []
    item_rows = items_response.get("data") or []
    item_master = {str(row.get("ItemCode")): row for row in item_rows}
    rows: list[dict[str, Any]] = []

    for source in stock_rows:
        if source.get("WhsCode") != WAREHOUSE_CODE:
            continue
        sap_code = str(source.get("ItemCode") or "")
        if not sap_code.startswith("FG"):
            continue
        item_name = str(source.get("ItemName") or sap_code)
        master = item_master.get(sap_code, {})
        on_hand = float(source.get("OnHand") or 0)
        committed = float(source.get("Committed") or 0)
        on_order = float(source.get("OnOrder") or 0)
        available = float(source.get("Available") or (on_hand - committed))
        unit_cost = float(master.get("LastPurchasePrice") or 0)
        factor = litre_factor(item_name)
        item_head, category = classify_item(item_name)
        rows.append(
            {
                "sapCode": sap_code,
                "sourceSapCodes": [sap_code],
                "sourceItemNames": [item_name],
                "itemName": item_name,
                "shortName": item_name,
                "itemHead": item_head,
                "category": category,
                "warehouseCode": WAREHOUSE_CODE,
                "warehouse": WAREHOUSE_NAME,
                "city": "SONIPAT",
                "onHand": on_hand,
                "liters": round(on_hand * factor, 2),
                "committed": committed,
                "available": available,
                "onOrder": on_order,
                "stockValue": round(on_hand * unit_cost, 2),
                "status": inventory_status(on_hand, committed, available),
            }
        )

    rows.sort(key=lambda row: (row["status"] != "Critical", row["available"], row["sapCode"]))
    totals = {
        "skus": len(rows),
        "onHand": round(sum(row["onHand"] for row in rows), 2),
        "liters": round(sum(row["liters"] for row in rows), 2),
        "committed": round(sum(row["committed"] for row in rows), 2),
        "available": round(sum(row["available"] for row in rows), 2),
        "onOrder": round(sum(row["onOrder"] for row in rows), 2),
        "stockValue": round(sum(row["stockValue"] for row in rows), 2),
        "criticalSkus": sum(row["status"] == "Critical" for row in rows),
        "lowSkus": sum(row["status"] == "Low" for row in rows),
        "unmappedSkus": sum(row["category"] == "OTHER" for row in rows),
    }
    return {
        "status": "live",
        "observedAt": observed_at or datetime.now(timezone.utc).isoformat(),
        "warehouseCode": WAREHOUSE_CODE,
        "warehouseName": WAREHOUSE_NAME,
        "source": "Ecom CLI · SAP stock-by-warehouse",
        "refreshSeconds": CACHE_SECONDS,
        "rows": rows,
        "totals": totals,
    }


def get_live_inventory(force: bool = False) -> dict[str, Any]:
    now = time.monotonic()
    with _cache_lock:
        if not force and _cache["payload"] is not None and now < _cache["expires"]:
            return _cache["payload"]

    stock = fetch_json("/api/sap/stock-by-warehouse?page_size=2000")
    items = fetch_json("/api/sap/items?page=0&page_size=2000")
    payload = build_inventory_payload(stock, items)
    with _cache_lock:
        _cache["payload"] = payload
        _cache["expires"] = time.monotonic() + CACHE_SECONDS
    return payload


def normalized_item_name(value: object) -> str:
    return " ".join(re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).split())


def movement_distributor(value: object) -> str | None:
    vendor = str(value or "").upper()
    return next(
        (identifier for identifier, (_, alias) in TRACKED_DISTRIBUTORS.items() if alias in vendor),
        None,
    )


def fetch_recent_master_po(min_delivery_date: str) -> list[dict[str, Any]]:
    """Fetch all table pages, retaining only potentially relevant movement rows."""
    count = int(fetch_json("/api/dashboard/table-count/master_po").get("count") or 0)
    page_size = 5000
    pages = (count + page_size - 1) // page_size
    def fetch_page(page: int) -> dict[str, Any]:
        return fetch_json(
            f"/api/dashboard/table-data/master_po?page={page}&page_size={page_size}",
            timeout=90,
        )

    retained: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = pool.map(fetch_page, range(pages))
        for response in responses:
            for row in response.get("data") or []:
                delivery_date = str(row.get("delivery_date") or "")[:10]
                identifier = movement_distributor(row.get("vendor_new") or row.get("vendor_name"))
                if identifier and delivery_date > min_delivery_date:
                    retained.append(row)
    return retained


def fetch_sales_analysis(start: date, end: date) -> list[dict[str, Any]]:
    page_size = 5000

    def path(page: int) -> str:
        return "/api/sap/sales-analysis?" + urllib.parse.urlencode(
            {
                "from_date": start.isoformat(),
                "to_date": end.isoformat(),
                "page": page,
                "page_size": page_size,
            }
        )

    first = fetch_json(path(0), timeout=90)
    rows = list(first.get("data") or [])
    count = int(first.get("count") or len(rows))
    pages = (count + page_size - 1) // page_size
    if pages > 1:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for response in pool.map(lambda page: fetch_json(path(page), timeout=90), range(1, pages)):
                rows.extend(response.get("data") or [])
    return rows


def build_distributor_payload(
    baseline_payload: dict[str, Any],
    sales_rows: list[dict[str, Any]],
    master_po_rows: list[dict[str, Any]],
    item_rows: list[dict[str, Any]],
    observed_at: str | None = None,
) -> dict[str, Any]:
    baseline_by_id = {row["id"]: row for row in baseline_payload["distributors"]}
    card_to_id = {code: identifier for identifier, (code, _) in TRACKED_DISTRIBUTORS.items()}
    unique_names: dict[str, set[str]] = defaultdict(set)
    item_by_code: dict[str, dict[str, Any]] = {}
    for item in item_rows:
        code = str(item.get("ItemCode") or "")
        if code.startswith("FG"):
            item_by_code[code] = item
            unique_names[normalized_item_name(item.get("ItemName"))].add(code)

    billing: dict[tuple[str, str], float] = defaultdict(float)
    for row in sales_rows:
        identifier = card_to_id.get(str(row.get("CardCode") or ""))
        if not identifier:
            continue
        baseline = baseline_by_id[identifier]
        document_date = str(row.get("DocDate") or "")[:10]
        if document_date <= baseline["asOf"]:
            continue
        quantity = float(row.get("Quantity") or 0)
        if str(row.get("Type") or "").upper() == "SALES RETURN":
            quantity = -abs(quantity)
        if quantity == 0:
            continue
        billing[(identifier, str(row.get("ItemCode") or ""))] += quantity

    grn: dict[tuple[str, str], float] = defaultdict(float)
    unresolved_grn: dict[str, float] = defaultdict(float)
    seen_grn: set[tuple[Any, ...]] = set()
    for row in master_po_rows:
        identifier = movement_distributor(row.get("vendor_new") or row.get("vendor_name"))
        if not identifier:
            continue
        baseline = baseline_by_id[identifier]
        delivery_date = str(row.get("delivery_date") or "")[:10]
        if delivery_date <= baseline["asOf"]:
            continue
        dedupe_key = (
            identifier,
            row.get("po_number"),
            row.get("format"),
            row.get("sku_code"),
            row.get("location"),
            delivery_date,
            row.get("delivered_qty"),
        )
        if dedupe_key in seen_grn:
            continue
        seen_grn.add(dedupe_key)
        quantity = float(row.get("delivered_qty") or 0)
        if quantity == 0:
            continue
        candidates = unique_names.get(normalized_item_name(row.get("sap_sku_name")), set())
        if len(candidates) != 1:
            unresolved_grn[identifier] += quantity
            continue
        grn[(identifier, next(iter(candidates)))] += quantity

    distributors: list[dict[str, Any]] = []
    all_totals = {"opening": 0.0, "billing": 0.0, "grn": 0.0, "projected": 0.0}
    premium_totals = {"opening": 0.0, "billing": 0.0, "grn": 0.0, "projected": 0.0}
    for identifier in ("chirag", "antize", "baba"):
        baseline = baseline_by_id[identifier]
        rows_by_code = {row["sapCode"]: dict(row) for row in baseline["rows"]}
        movement_codes = {
            code for (owner, code) in set(billing) | set(grn) if owner == identifier and code
        }
        for code in movement_codes - set(rows_by_code):
            item_name = str(item_by_code.get(code, {}).get("ItemName") or code)
            rows_by_code[code] = {
                "sapCode": code,
                "itemName": item_name,
                "reportedOpeningPieces": 0,
                "usableOpeningPieces": 0,
                "openingStatus": "qualified",
                "openingEvidence": "zero inferred from complete physical report",
            }

        projected_rows = []
        for code, source in rows_by_code.items():
            opening = float(source["usableOpeningPieces"])
            billed = billing[(identifier, code)]
            accepted = grn[(identifier, code)]
            projected = opening + billed - accepted
            item_head, category = classify_item(source.get("itemName") or code)
            projected_rows.append(
                {
                    **source,
                    "itemHead": item_head,
                    "category": category,
                    "billingPieces": billed,
                    "grnPieces": accepted,
                    "projectedPieces": projected,
                    "status": "exception" if projected < 0 or source["openingStatus"] != "qualified" else "qualified",
                }
            )

        def scope_totals(scope: str) -> dict[str, float]:
            scoped = [row for row in projected_rows if scope == "all" or row["itemHead"] == "PREMIUM"]
            return {
                "opening": sum(float(row["usableOpeningPieces"]) for row in scoped),
                "billing": sum(float(row["billingPieces"]) for row in scoped),
                "grn": sum(float(row["grnPieces"]) for row in scoped),
                "projected": sum(float(row["projectedPieces"]) for row in scoped),
            }

        all_scope = scope_totals("all")
        premium_scope = scope_totals("premium")
        for key in all_totals:
            all_totals[key] += all_scope[key]
            premium_totals[key] += premium_scope[key]
        distributors.append(
            {
                "id": identifier,
                "code": baseline["code"],
                "name": baseline["name"],
                "asOf": baseline["asOf"],
                "sourceFile": baseline["sourceFile"],
                "openingMissing": False,
                "negativeSkuCount": sum(row["projectedPieces"] < 0 for row in projected_rows),
                "openingExceptionSkus": baseline["negativeOpeningSkus"],
                "activeSkuCount": sum(row["projectedPieces"] != 0 for row in projected_rows),
                "premiumSkuCount": sum(row["itemHead"] == "PREMIUM" for row in projected_rows),
                "unresolvedGrnPieces": unresolved_grn[identifier],
                "live": {"leadTimeDays": None, "all": all_scope, "premium": premium_scope},
                "rows": sorted(projected_rows, key=lambda row: (row["status"] != "exception", row["projectedPieces"])),
            }
        )

    return {
        "status": "live-projection",
        "observedAt": observed_at or datetime.now(timezone.utc).isoformat(),
        "formula": baseline_payload["formula"],
        "sources": [
            "Qualified distributor physical-count workbooks",
            "Ecom SAP sales-analysis billing",
            "Ecom master_po delivered/GRN rows",
        ],
        "distributors": distributors,
        "totals": {"all": all_totals, "premium": premium_totals},
    }


def get_live_distributors(force: bool = False) -> dict[str, Any]:
    now = time.monotonic()
    with _cache_lock:
        if (
            not force
            and _distributor_cache["payload"] is not None
            and now < _distributor_cache["expires"]
        ):
            return _distributor_cache["payload"]

    baseline_payload = json.loads(BASELINES_PATH.read_text())
    baseline_dates = [row["asOf"] for row in baseline_payload["distributors"]]
    start = min(date.fromisoformat(value) for value in baseline_dates) + timedelta(days=1)
    end = date.today()
    sales_rows = fetch_sales_analysis(start, end)
    items = fetch_json("/api/sap/items?page=0&page_size=2000")
    master_po = fetch_recent_master_po(min(baseline_dates))
    payload = build_distributor_payload(
        baseline_payload,
        sales_rows,
        master_po,
        items.get("data") or [],
    )
    with _cache_lock:
        _distributor_cache["payload"] = payload
        _distributor_cache["expires"] = time.monotonic() + DISTRIBUTOR_CACHE_SECONDS
    return payload


class GatewayHandler(BaseHTTPRequestHandler):
    upstream = "http://127.0.0.1:3301"
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}", flush=True)

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "private, no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_inventory(self) -> None:
        try:
            self._json(200, get_live_inventory(force="refresh=1" in self.path))
        except urllib.error.HTTPError as exc:
            self._json(502, {"status": "error", "error": f"Ecom API returned HTTP {exc.code}"})
        except Exception as exc:  # defensive boundary: never leak credentials
            self._json(502, {"status": "error", "error": str(exc)})

    def _serve_distributors(self) -> None:
        try:
            self._json(200, get_live_distributors(force="refresh=1" in self.path))
        except urllib.error.HTTPError as exc:
            self._json(502, {"status": "error", "error": f"Ecom API returned HTTP {exc.code}"})
        except Exception as exc:  # defensive boundary: never leak credentials
            self._json(502, {"status": "error", "error": str(exc)})

    def _serve_msl(self) -> None:
        try:
            self._json(200, read_msl_store())
        except Exception:
            self._json(500, {"status": "error", "error": "Planner MSL store is unavailable"})

    def _update_msl(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 1 or length > 4096:
                self._json(400, {"status": "error", "error": "Invalid request size"})
                return
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be an object")
            sap_code = payload.get("sapCode")
            pieces = payload.get("pieces")
            if not isinstance(sap_code, str):
                raise ValueError("sapCode is required")
            if pieces is not None and (isinstance(pieces, bool) or not isinstance(pieces, int)):
                raise ValueError("pieces must be a whole number or null")
            self._json(200, update_msl_value(sap_code, pieces))
        except (json.JSONDecodeError, ValueError) as exc:
            self._json(400, {"status": "error", "error": str(exc)})
        except Exception:
            self._json(500, {"status": "error", "error": "Planner MSL store is unavailable"})

    def _proxy(self) -> None:
        target = self.upstream + self.path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
        }
        request = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response_body = response.read()
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(response_body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(response_body)
        except urllib.error.HTTPError as exc:
            response_body = exc.read()
            self.send_response(exc.code)
            for key, value in exc.headers.items():
                if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "content-length":
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(response_body)
        except Exception:
            self._json(502, {"status": "error", "error": "Application upstream is unavailable"})

    def do_GET(self) -> None:  # noqa: N802
        route = urllib.parse.urlsplit(self.path).path
        if route == "/api/live/inventory":
            self._serve_inventory()
        elif route == "/api/live/distributors":
            self._serve_distributors()
        elif route == "/api/planner/msl":
            self._serve_msl()
        else:
            self._proxy()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._proxy()

    def do_PUT(self) -> None:  # noqa: N802
        route = urllib.parse.urlsplit(self.path).path
        if route == "/api/planner/msl":
            self._update_msl()
        else:
            self._proxy()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=3300, type=int)
    parser.add_argument("--upstream", default="http://127.0.0.1:3301")
    args = parser.parse_args()
    GatewayHandler.upstream = args.upstream.rstrip("/")
    server = ThreadingHTTPServer((args.host, args.port), GatewayHandler)
    print(f"Live gateway listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()
