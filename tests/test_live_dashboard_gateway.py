import importlib.util
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
        self.assertEqual(antize["live"]["all"]["billing"], 40)
        self.assertEqual(antize["live"]["all"]["grn"], 15)
        self.assertEqual(antize["live"]["all"]["projected"], 125)
        self.assertEqual(antize["unresolvedGrnPieces"], 0)
        self.assertEqual(result["status"], "live-projection")


if __name__ == "__main__":
    unittest.main()
