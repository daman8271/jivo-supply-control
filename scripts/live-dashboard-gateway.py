#!/usr/bin/env python3
"""Read-only live-data gateway for the Jivo Supply Control preview.

The gateway keeps JIVO credentials server-side. It serves live GET projections at
/api/live/* and reverse-proxies the Vinext application for every other route.
It never calls a mutating source-system endpoint.
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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CONFIG_PATH = Path.home() / ".config/jivo-ecom-pp-cli/config.toml"
WAREHOUSE_CODE = "GP-FGM"
WAREHOUSE_NAME = "GUPTA FINISHED GOODS MART"
CACHE_SECONDS = 30
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
        if urllib.parse.urlsplit(self.path).path == "/api/live/inventory":
            self._serve_inventory()
        else:
            self._proxy()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
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
