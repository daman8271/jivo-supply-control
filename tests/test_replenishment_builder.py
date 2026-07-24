import importlib.util
import unittest
from datetime import date
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "build-distributor-replenishment.py"
SPEC = importlib.util.spec_from_file_location("replenishment_builder", SCRIPT)
assert SPEC and SPEC.loader
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def po_row(**overrides):
    row = {
        "po_number": "PO-1",
        "open_close": "OPEN",
        "po_status": "PENDING",
        "status": "CONFIRMED",
        "item_status": "PENDING",
        "po_expiry_date": "2026-07-31",
        "order_qty": 100,
        "delivered_qty": 40,
        "filled_qty": 40,
    }
    row.update(overrides)
    return row


class BuilderQualificationTests(unittest.TestCase):
    def test_partial_delivery_uses_only_open_piece_balance(self):
        result = BUILDER.qualify_open_po_row(po_row(), date(2026, 7, 24))
        self.assertEqual(result["openPieces"], 60)

    def test_cancelled_and_expired_lines_are_excluded(self):
        cancelled = po_row(status="CANCELLED")
        expired = po_row(po_expiry_date="2026-07-23")
        self.assertIsNone(BUILDER.qualify_open_po_row(cancelled, date(2026, 7, 24)))
        self.assertIsNone(BUILDER.qualify_open_po_row(expired, date(2026, 7, 24)))

    def test_unknown_open_status_fails_closed(self):
        with self.assertRaises(ValueError):
            BUILDER.qualify_open_po_row(po_row(status="UNKNOWN_STATE"), date(2026, 7, 24))

    def test_exact_duplicates_collapse_and_conflicting_versions_fail(self):
        seen = {}
        key = ("chirag", "AMAZON", "PO-1", "SKU-1", "MUMBAI")
        self.assertTrue(BUILDER.accept_deduplicated_line(seen, key, (100, 40)))
        self.assertFalse(BUILDER.accept_deduplicated_line(seen, key, (100, 40)))
        with self.assertRaises(ValueError):
            BUILDER.accept_deduplicated_line(seen, key, (100, 20))

    def test_blank_stock_cell_is_missing_not_zero(self):
        self.assertIsNone(BUILDER.explicit_integer(""))
        self.assertIsNone(BUILDER.explicit_integer(None))
        self.assertEqual(BUILDER.explicit_integer(0), 0)

    def test_python_formula_subtracts_confirmed_inbound_and_hides_packless_need(self):
        self.assertEqual(
            BUILDER.round_replenishment(101, 20, 5, True, 16),
            (76, 80, "replenish", None),
        )
        raw, recommended, status, _ = BUILDER.round_replenishment(100, 35, 0, True, None)
        self.assertIsNone(raw)
        self.assertIsNone(recommended)
        self.assertEqual(status, "blocked")


if __name__ == "__main__":
    unittest.main()
