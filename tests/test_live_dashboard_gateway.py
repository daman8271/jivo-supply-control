import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "live-dashboard-gateway.py"
SPEC = importlib.util.spec_from_file_location("live_dashboard_gateway", SCRIPT)
assert SPEC and SPEC.loader
GATEWAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATEWAY)


class LiveInventoryProjectionTests(unittest.TestCase):
    def test_filters_exact_gp_fgm_finished_goods_and_reconciles_totals(self):
        stock = {
            "data": [
                {
                    "ItemCode": "FG1",
                    "ItemName": "TEST OLIVE 1 LTR 12 PCS",
                    "WhsCode": "GP-FGM",
                    "OnHand": 100,
                    "Committed": 30,
                    "OnOrder": 20,
                    "Available": 70,
                },
                {
                    "ItemCode": "FG2",
                    "ItemName": "TEST GROUNDNUT 5 LTR 4 PCS",
                    "WhsCode": "GP-FGM",
                    "OnHand": 10,
                    "Committed": 15,
                    "OnOrder": 0,
                    "Available": -5,
                },
                {
                    "ItemCode": "FG3",
                    "ItemName": "WRONG WAREHOUSE",
                    "WhsCode": "BH-FGM",
                    "OnHand": 999,
                    "Committed": 0,
                    "OnOrder": 0,
                    "Available": 999,
                },
                {
                    "ItemCode": "PM1",
                    "ItemName": "PACKAGING",
                    "WhsCode": "GP-FGM",
                    "OnHand": 999,
                    "Committed": 0,
                    "OnOrder": 0,
                    "Available": 999,
                },
            ]
        }
        items = {
            "data": [
                {"ItemCode": "FG1", "LastPurchasePrice": 200},
                {"ItemCode": "FG2", "LastPurchasePrice": 500},
            ]
        }

        result = GATEWAY.build_inventory_payload(
            stock, items, observed_at="2026-07-30T12:00:00+00:00"
        )

        self.assertEqual(result["warehouseCode"], "GP-FGM")
        self.assertEqual(result["totals"]["skus"], 2)
        self.assertEqual(result["totals"]["onHand"], 110)
        self.assertEqual(result["totals"]["committed"], 45)
        self.assertEqual(result["totals"]["available"], 65)
        self.assertEqual(result["totals"]["onOrder"], 20)
        self.assertEqual(result["totals"]["stockValue"], 25000)
        self.assertEqual(result["totals"]["liters"], 150)
        self.assertEqual(result["totals"]["criticalSkus"], 1)
        self.assertEqual(result["rows"][0]["sapCode"], "FG2")
        self.assertEqual(result["rows"][0]["status"], "Critical")

    def test_inventory_status_fails_closed_on_negative_available(self):
        self.assertEqual(GATEWAY.inventory_status(10, 15, -5), "Critical")
        self.assertEqual(GATEWAY.inventory_status(100, 95, 5), "Low")
        self.assertEqual(GATEWAY.inventory_status(100, 10, 90), "Healthy")


class LiveDistributorProjectionTests(unittest.TestCase):
    def test_configures_the_confirmed_lead_time_for_all_six_distributors(self):
        self.assertEqual(
            {
                identifier: config["leadTimeDays"]
                for identifier, config in GATEWAY.TRACKED_DISTRIBUTORS.items()
            },
            {
                "chirag": 5,
                "knowtable": 8,
                "evara": 2,
                "antize": 2,
                "baba": 8,
                "sustainquest": 2,
            },
        )

    def test_projects_qualified_opening_with_post_cutoff_billing_and_grn(self):
        baselines = {
            "formula": "opening + billing - GRN",
            "distributors": [
                {
                    "id": identifier,
                    "code": code,
                    "name": identifier.title(),
                    "asOf": cutoff,
                    "sourceFile": f"{identifier}.xlsx",
                    "negativeOpeningSkus": 0,
                    "rows": [
                        {
                            "sapCode": "FG1",
                            "itemName": "GROUNDNUT OIL 1 LTR",
                            "reportedOpeningPieces": 100,
                            "usableOpeningPieces": 100,
                            "openingStatus": "qualified",
                        }
                    ],
                }
                for identifier, code, cutoff in (
                    ("chirag", "CUSTA000354", "2026-07-29"),
                    ("antize", "CUSTA000927", "2026-07-28"),
                    ("baba", "CUSTA000900", "2026-07-30"),
                )
            ],
        }
        sales = [
            {
                "CardCode": "CUSTA000927",
                "DocDate": "2026-07-29T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 40,
                "Type": "Sales",
            },
            {
                "CardCode": "CUSTA000927",
                "DocDate": "2026-07-28T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 999,
                "Type": "Sales",
            },
        ]
        master_po = [
            {
                "vendor_new": "ANTIZE FOODS PRIVATE LIMITED",
                "po_number": "PO1",
                "format": "BLINKIT",
                "sku_code": "SKU1",
                "location": "DELHI",
                "delivery_date": "2026-07-29",
                "delivered_qty": 15,
                "sap_sku_name": "GROUNDNUT OIL 1 LTR",
            }
        ]
        items = [{"ItemCode": "FG1", "ItemName": "GROUNDNUT OIL 1 LTR"}]

        result = GATEWAY.build_distributor_payload(
            baselines, sales, master_po, items, "2026-07-30T12:00:00+00:00"
        )
        antize = next(row for row in result["distributors"] if row["id"] == "antize")

        self.assertEqual(antize["live"]["all"]["opening"], 100)
        self.assertEqual(antize["live"]["all"]["billing"], 0)
        self.assertEqual(antize["live"]["all"]["inTransit"], 40)
        self.assertEqual(antize["live"]["all"]["grn"], 15)
        self.assertEqual(antize["live"]["all"]["projected"], 85)
        self.assertEqual(antize["unresolvedGrnPieces"], 0)
        self.assertEqual(result["status"], "live-projection")

    def test_holds_recent_billing_in_transit_until_each_distributor_lead_time(self):
        baselines = {
            "formula": "opening + arrived billing - GRN",
            "distributors": [
                {
                    "id": "chirag",
                    "code": "CUSTA000354",
                    "name": "Chirag Enterprises Mumbai",
                    "asOf": "2026-07-20",
                    "sourceFile": "chirag.xlsx",
                    "negativeOpeningSkus": 0,
                    "rows": [
                        {
                            "sapCode": "FG1",
                            "itemName": "GROUNDNUT OIL 1 LTR",
                            "reportedOpeningPieces": 100,
                            "usableOpeningPieces": 100,
                            "openingStatus": "qualified",
                        }
                    ],
                },
                {
                    "id": "antize",
                    "code": "CUSTA000927",
                    "name": "Antize Foods",
                    "asOf": "2026-07-20",
                    "sourceFile": "antize.xlsx",
                    "negativeOpeningSkus": 0,
                    "rows": [
                        {
                            "sapCode": "FG1",
                            "itemName": "GROUNDNUT OIL 1 LTR",
                            "reportedOpeningPieces": 100,
                            "usableOpeningPieces": 100,
                            "openingStatus": "qualified",
                        }
                    ],
                },
            ],
        }
        sales = [
            {
                "CardCode": "CUSTA000354",
                "DocDate": "2026-07-27T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 40,
                "Type": "Sales",
            },
            {
                "CardCode": "CUSTA000354",
                "DocDate": "2026-07-28T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 60,
                "Type": "Sales",
            },
            {
                "CardCode": "CUSTA000927",
                "DocDate": "2026-07-29T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 25,
                "Type": "Sales",
            },
            {
                "CardCode": "CUSTA000592",
                "DocDate": "2026-07-29T00:00:00",
                "ItemCode": "FG1",
                "Quantity": 15,
                "Type": "Sales",
            },
        ]

        result = GATEWAY.build_distributor_payload(
            baselines,
            sales,
            [],
            [{"ItemCode": "FG1", "ItemName": "GROUNDNUT OIL 1 LTR"}],
            "2026-07-31T06:30:00+00:00",
        )
        chirag = next(row for row in result["distributors"] if row["id"] == "chirag")
        antize = next(row for row in result["distributors"] if row["id"] == "antize")
        transit = {row["id"]: row for row in result["transit"]}

        self.assertEqual(chirag["live"]["leadTimeDays"], 5)
        self.assertEqual(chirag["live"]["all"]["billing"], 0)
        self.assertEqual(chirag["live"]["all"]["inTransit"], 100)
        self.assertEqual(chirag["live"]["all"]["projected"], 100)
        self.assertEqual(antize["live"]["all"]["billing"], 25)
        self.assertEqual(antize["live"]["all"]["inTransit"], 0)
        self.assertEqual(antize["live"]["all"]["projected"], 125)
        self.assertEqual(transit["knowtable"]["leadTimeDays"], 8)
        self.assertEqual(transit["knowtable"]["pieces"], 15)
        self.assertEqual(transit["knowtable"]["rows"][0]["expectedArrivalDate"], "2026-08-06")


class PlannerMslStoreTests(unittest.TestCase):
    def test_persists_updates_and_clears_values_atomically(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "msl.json"
            self.assertEqual(GATEWAY.read_msl_store(path)["values"], {})

            saved = GATEWAY.update_msl_value("FG0000142", 2500, path)
            self.assertEqual(saved["values"], {"FG0000142": 2500})
            self.assertEqual(GATEWAY.read_msl_store(path)["values"], {"FG0000142": 2500})

            cleared = GATEWAY.update_msl_value("FG0000142", None, path)
            self.assertEqual(cleared["values"], {})
            self.assertEqual(GATEWAY.read_msl_store(path)["values"], {})

    def test_rejects_invalid_codes_and_quantities(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "msl.json"
            for code, pieces in [("../../bad", 10), ("FG1", -1), ("FG1", 1.5), ("FG1", True)]:
                with self.assertRaises(ValueError):
                    GATEWAY.update_msl_value(code, pieces, path)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
