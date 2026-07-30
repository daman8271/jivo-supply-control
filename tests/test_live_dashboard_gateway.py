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


if __name__ == "__main__":
    unittest.main()
