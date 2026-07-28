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
        "po_date": "2026-06-15",
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

    def test_requirement_uses_previous_full_month_and_excludes_only_cancelled(self):
        month_start, month_end = BUILDER.previous_calendar_month(date(2026, 7, 24))
        self.assertEqual((month_start, month_end), (date(2026, 6, 1), date(2026, 6, 30)))
        completed = po_row(open_close="CLOSED", status="COMPLETED")
        expired = po_row(open_close="CLOSED", status="EXPIRED")
        cancelled = po_row(status="CANCELLED")
        canceled = po_row(status="CANCELED")
        cancelled_post_creation = po_row(status="CANCELLED POST CREATION")
        july = po_row(po_date="2026-07-01")
        self.assertEqual(
            BUILDER.qualify_requirement_po_row(completed, month_start, month_end)["orderQty"],
            100,
        )
        self.assertEqual(
            BUILDER.qualify_requirement_po_row(expired, month_start, month_end)["orderQty"],
            100,
        )
        self.assertIsNone(BUILDER.qualify_requirement_po_row(cancelled, month_start, month_end))
        self.assertIsNone(BUILDER.qualify_requirement_po_row(canceled, month_start, month_end))
        self.assertIsNone(
            BUILDER.qualify_requirement_po_row(cancelled_post_creation, month_start, month_end)
        )
        self.assertIsNone(BUILDER.qualify_requirement_po_row(july, month_start, month_end))

    def test_requirement_rounds_80_percent_up_to_next_piece(self):
        self.assertEqual(BUILDER.calculate_required_inventory(100), 80)
        self.assertEqual(BUILDER.calculate_required_inventory(101), 81)

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
        with self.assertRaises(ValueError):
            BUILDER.explicit_integer(2.5)

    def test_python_formula_subtracts_confirmed_inbound_and_hides_packless_need(self):
        self.assertEqual(
            BUILDER.round_replenishment(101, 20, 5, True, True, 16),
            (76, 80, "replenish", None),
        )
        raw, recommended, status, _ = BUILDER.round_replenishment(100, 35, 0, True, True, None)
        self.assertIsNone(raw)
        self.assertIsNone(recommended)
        self.assertEqual(status, "blocked")

    def test_missing_inbound_evidence_blocks_instead_of_assuming_zero(self):
        raw, recommended, status, blocker = BUILDER.round_replenishment(
            100, 35, None, True, False, 10
        )
        self.assertIsNone(raw)
        self.assertIsNone(recommended)
        self.assertEqual(status, "blocked")
        self.assertIn("inbound evidence is missing", blocker.lower())


if __name__ == "__main__":
    unittest.main()
