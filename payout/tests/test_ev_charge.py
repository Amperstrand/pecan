#!/usr/bin/env python3
"""Unit tests for the ev-charge adapter's money-critical logic.

The console and gateway are faked in-process — these tests pin the
refund-validation matrix (the payment-testing discipline: over-claim,
duplicate, unknown, unordered), the tariff snapshot, and the
metering-loss settle policy without any network or device.

Run: python3 -m unittest discover -s payout/tests -v
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# The adapter's filename carries a hyphen (the systemd unit references
# /opt/pecan-tools/ev-charge.py), so it is not importable by name.
_ADAPTER = Path(__file__).resolve().parent.parent / "ev-charge.py"
_spec = importlib.util.spec_from_file_location("ev_charge", _ADAPTER)
ev_charge = importlib.util.module_from_spec(_spec)
sys.modules["ev_charge"] = ev_charge
_spec.loader.exec_module(ev_charge)


class FakeConsole:
    """Records posts; answers open-ticket scans from a script."""

    def __init__(self, open_tickets=None):
        self.posts = []
        self._open = open_tickets or []

    def get(self, path):
        if path.startswith("/api/tickets/open"):
            return self._open
        raise AssertionError(f"unexpected GET {path}")

    def post(self, path, payload):
        self.posts.append((path, payload))
        return {}


def daemon(secs_per_eur=1.0, open_tickets=None):
    console = FakeConsole(open_tickets)
    a = SimpleNamespace(secs_per_eur=secs_per_eur,
                        settle_grace=0.0, state_file="")
    a._tariffs = {}
    return a, console


def settled_record(amount_cents=600, delivered_cents=200):
    return {"status": "settled", "quote_id": "q-1",
            "amount_cents": amount_cents,
            "delivered_cents": delivered_cents,
            "refunded": False}


def refund_ticket(amount, quote_id="q-1", tid="MINT-refund-1"):
    return {"id": tid, "amount": amount,
            "description": f"refund:{quote_id}"}


class RefundValidationTests(unittest.TestCase):
    """settle_refunds must be an idempotent, capped, one-shot operation."""

    def test_valid_refund_settles_once(self):
        a, console = daemon(open_tickets=[refund_ticket(400)])
        state = {"t-1": settled_record()}
        ev_charge.settle_refunds(a, console, state)
        mark_paid = [p for p in console.posts if "mark-paid" in p[0]]
        self.assertEqual(len(mark_paid), 1)
        self.assertEqual(mark_paid[0][1]["receipt"][:7], "REFUND-")
        self.assertTrue(state["t-1"]["refunded"])
        # Second pass: already refunded — no double settle.
        console.posts.clear()
        ev_charge.settle_refunds(a, console, state)
        self.assertEqual(
            [p for p in console.posts if "mark-paid" in p[0]], [])

    def test_overclaim_refused(self):
        # Overpay is 600-200=400; a 401-cent claim must not settle.
        a, console = daemon(open_tickets=[refund_ticket(401)])
        state = {"t-1": settled_record()}
        with mock.patch.object(ev_charge, "log") as m:
            ev_charge.settle_refunds(a, console, state)
        self.assertEqual(
            [p for p in console.posts if "mark-paid" in p[0]], [])
        self.assertFalse(state["t-1"]["refunded"])
        m.assert_called_once()
        self.assertEqual(m.call_args[0][0]["result"], "refund-refused")

    def test_duplicate_refund_never_settles_twice(self):
        # Even if a second refund ticket appears after the first settled,
        # the ledger's refunded flag is a hard stop.
        a, console = daemon(open_tickets=[
            refund_ticket(400, tid="MINT-r1"),
            refund_ticket(400, tid="MINT-r2"),
        ])
        state = {"t-1": settled_record()}
        ev_charge.settle_refunds(a, console, state)
        # The first pass settles ONE of them (the ledger flips refunded);
        # the second is skipped within the same pass and forever after.
        mark_paid = [p for p in console.posts if "mark-paid" in p[0]]
        self.assertEqual(len(mark_paid), 1)
        console.posts.clear()
        ev_charge.settle_refunds(a, console, state)
        self.assertEqual(
            [p for p in console.posts if "mark-paid" in p[0]], [])

    def test_unknown_melt_ignored(self):
        # A refund naming a melt the daemon never settled is not ours —
        # left for an operator, never auto-settled.
        a, console = daemon(open_tickets=[refund_ticket(100, quote_id="nope")])
        state = {"t-1": settled_record()}
        ev_charge.settle_refunds(a, console, state)
        self.assertEqual(
            [p for p in console.posts if "mark-paid" in p[0]], [])

    def test_refund_for_unsettled_session_ignored(self):
        # The melt is still mid-flight (status != settled): refund later.
        a, console = daemon(open_tickets=[refund_ticket(400)])
        state = {"t-1": {"status": "triggered", "quote_id": "q-1"}}
        ev_charge.settle_refunds(a, console, state)
        self.assertEqual(
            [p for p in console.posts if "mark-paid" in p[0]], [])

    def test_non_refund_tickets_untouched(self):
        # Ordinary open deposits (teller funding cards) are not refunds.
        a, console = daemon(open_tickets=[
            {"id": "MINT-1", "amount": 500, "description": "Wallet deposit"},
        ])
        state = {}
        ev_charge.settle_refunds(a, console, state)
        self.assertEqual(console.posts, [])


class FakeGateway:
    def __init__(self, statuses):
        self._statuses = statuses
        self.triggers = []

    def trigger(self, device, seconds, session_ref=None):
        self.triggers.append((device, seconds, session_ref))
        return {"triggered": True, "session": "s-1"}

    def status(self, device):
        return self._statuses.pop(0) if self._statuses else {"state": "done"}


class DeliverEnergyTests(unittest.TestCase):
    def _args(self, secs_per_eur=1.0):
        a, console = daemon(secs_per_eur)
        a._tariffs["t-1"] = secs_per_eur
        # deliver_energy marks paid through the module-global console.
        ev_charge.console = console
        self.addCleanup(lambda: setattr(ev_charge, "console", None))
        return a, console

    def test_stopped_session_bills_delivered_and_marks_metadata(self):
        a, console = self._args()
        gw = FakeGateway([{"state": "done", "seconds": 2, "stopped": True}])
        code, result = ev_charge.deliver_energy(
            a, gw, "t-1", 600, "atomA", {}, session_ref="q-1")
        self.assertEqual(code, 0)
        self.assertEqual(result["delivered_cents"], 200)
        self.assertTrue(result["stopped"])
        self.assertTrue(result["receipt"].endswith("-STOPPED"))
        payload = console.posts[0][1]
        self.assertEqual(payload["delivered"], 200)

    def test_metering_loss_settles_granted_window_with_timeout_receipt(self):
        # The old policy left these open — they burned at expiry with no
        # accounting (the 2026-09-03 drift). The granted window settles.
        a, console = self._args()  # default tariff; status never reports done
        gw = FakeGateway([])
        gw.status = lambda device: {"state": "running", "seconds": 5}
        code, result = ev_charge.deliver_energy(
            a, gw, "t-1", 600, "atomA", {})
        self.assertEqual(code, 6)
        self.assertEqual(result["result"], "device-timeout-settled")
        self.assertTrue(result["receipt"].endswith("-TIMEOUT"))
        payload = console.posts[0][1]
        self.assertEqual(payload["delivered"], 600)

    def test_tariff_snapshot_used_not_current_flag(self):
        # The ticket was priced at 5 s/€; the daemon now runs 1 s/€.
        # Billing must use the SNAPSHOT (600 cents at 5 s/€ over 2
        # delivered seconds = 40 cents), not the current flag (200).
        a, console = self._args(secs_per_eur=1.0)
        a._tariffs["t-1"] = 5.0
        gw = FakeGateway([{"state": "done", "seconds": 2, "stopped": True}])
        _, result = ev_charge.deliver_energy(
            a, gw, "t-1", 600, "atomA", {})
        self.assertEqual(result["delivered_cents"], 40)

    def test_device_refusal_exits_without_settling(self):
        a, console = self._args()
        gw = FakeGateway([])
        gw.trigger = lambda device, seconds, session_ref=None: {
            "triggered": False, "reason": "declined"}
        code, result = ev_charge.deliver_energy(
            a, gw, "t-1", 600, "atomA", {})
        self.assertEqual(code, 2)
        self.assertEqual(console.posts, [])

    def test_session_ref_passed_to_gateway(self):
        a, console = self._args()
        gw = FakeGateway([{"state": "done", "seconds": 1}])
        ev_charge.deliver_energy(a, gw, "t-1", 100, "atomA", {},
                                 session_ref="q-9")
        self.assertEqual(gw.triggers[0][2], "q-9")


if __name__ == "__main__":
    unittest.main()
