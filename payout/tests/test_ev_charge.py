#!/usr/bin/env python3
"""Unit tests for the ev-charge adapter's money-critical logic.

The console and gateway are faked in-process — these tests pin the
refund-validation matrix (the payment-testing discipline: over-claim,
duplicate, unknown, unordered), the tariff snapshot, and the
metering-loss settle policy without any network or device.

Run: python3 -m unittest discover -s payout/tests -v
"""
import importlib.util
import json
import sys
import unittest
import urllib.error
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


class ExpiredActionTests(unittest.TestCase):
    """Issue #13: the pure predicate separating expired never-triggered
    deposit melts (auto-refund via the mint's rollback) from waiting
    tickets (close) and triggered sessions (never touched)."""

    NOW = 1_000_000.0

    def ticket(self, status="pending", expires=NOW - 10):
        return {"id": "MELT-1", "status": status, "amount": 300,
                "quote_id": "q-1", "expires_at": expires}

    def test_not_expired_is_left_alone(self):
        t = self.ticket(expires=self.NOW + 60)
        self.assertIsNone(ev_charge.expired_action(t, {}, self.NOW))

    def test_funded_never_triggered_refunds(self):
        # The wallet locked funds (ticket left waiting), the daemon never
        # triggered: full deposit back via the rollback.
        self.assertEqual(
            ev_charge.expired_action(self.ticket(), {}, self.NOW),
            "refund")

    def test_waiting_expired_closes_with_nothing_due(self):
        # No fund lock: nothing was burned, nothing is owed.
        self.assertEqual(
            ev_charge.expired_action(self.ticket(status="waiting"), {},
                                     self.NOW),
            "close")

    def test_refused_record_still_refunds(self):
        # Gateway declined/unreachable at trigger time: no energy ever
        # flowed. Before issue #13 these lingered funded-and-expired.
        rec = {"status": "refused", "result": "refused"}
        self.assertEqual(
            ev_charge.expired_action(self.ticket(), rec, self.NOW),
            "refund")

    def test_triggered_session_never_auto_refunded(self):
        # Energy may have flowed — partials settle through the normal
        # paths; the ledger's trigger record is the hard stop.
        for status in ("triggered", "settled", "open"):
            rec = {"status": status}
            self.assertIsNone(
                ev_charge.expired_action(self.ticket(), rec, self.NOW),
                msg=status)

    def test_margin_boundary_not_yet_expired(self):
        # Exactly margin seconds before expiry: not yet actionable.
        t = self.ticket(expires=self.NOW + 5)
        self.assertIsNone(ev_charge.expired_action(t, {}, self.NOW))

    def test_no_expiry_known_is_left_alone(self):
        t = self.ticket()
        del t["expires_at"]
        self.assertIsNone(ev_charge.expired_action(t, {}, self.NOW))


class ResolveExpiredTicketTests(unittest.TestCase):
    """The resolver must fail the ticket first, ledger second (retry on
    API error), record a refund entry the stop-path validator can never
    double-pay through, and warn operators OFF manual payback."""

    def _daemon(self, tmpdir):
        a = SimpleNamespace(secs_per_eur=1.0, settle_grace=0.0,
                            state_file=tmpdir + "/state.json")
        a._tariffs = {}
        return a

    def test_refund_writes_ledger_and_doublepay_warning(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a = self._daemon(d)
            console = FakeConsole()
            state = {}
            ev_charge.resolve_expired_ticket(
                a, console, state,
                {"id": "MELT-1", "status": "pending", "amount": 300,
                 "quote_id": "q-1", "expires_at": 1}, "refund")
            mark_failed = [p for p in console.posts
                           if "mark-failed" in p[0]]
            self.assertEqual(len(mark_failed), 1)
            self.assertIn("AUTO-REFUND", mark_failed[0][1]["notes"])
            self.assertIn("double-pay", mark_failed[0][1]["notes"])
            rec = state["MELT-1"]
            self.assertEqual(rec["status"], "open")
            self.assertEqual(rec["result"], "expired-before-trigger")
            self.assertEqual(rec["refund_via"], "mint-rollback")
            self.assertTrue(rec["refunded"])
            self.assertEqual(rec["amount_cents"], 300)
            self.assertEqual(rec["delivered_cents"], 0)
            self.assertEqual(rec["quote_id"], "q-1")
            # The refund ledger entry must never satisfy settle_refunds
            # (it requires status "settled"; the proofs were rolled back
            # and already back in the wallet).
            tickets = [refund_ticket(300, quote_id="q-1")]
            scan = FakeConsole(tickets)
            ev_charge.settle_refunds(a, scan, state)
            self.assertEqual(
                [p for p in scan.posts if "mark-paid" in p[0]], [])

    def test_close_writes_nothing_due(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a = self._daemon(d)
            console = FakeConsole()
            state = {}
            ev_charge.resolve_expired_ticket(
                a, console, state,
                {"id": "MELT-2", "status": "waiting", "amount": 300,
                 "expires_at": 1}, "close")
            notes = console.posts[0][1]["notes"]
            self.assertIn("nothing burned", notes)
            self.assertEqual(state["MELT-2"]["refund_due_cents"], 0)
            self.assertNotIn("refunded", state["MELT-2"])

    def test_api_error_leaves_record_for_retry(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a = self._daemon(d)

            class FailingConsole:
                def post(self, path, payload):
                    raise urllib.error.URLError("down")

                def get(self, path):
                    return []

            state = {}
            ev_charge.resolve_expired_ticket(
                a, FailingConsole(), state,
                {"id": "MELT-3", "status": "pending", "amount": 100,
                 "quote_id": "q-3", "expires_at": 1}, "refund")
            self.assertNotIn("MELT-3", state)
            # The decision stays live: the next poll retries.
            self.assertEqual(
                ev_charge.expired_action(
                    {"id": "MELT-3", "status": "pending", "amount": 100,
                     "quote_id": "q-3", "expires_at": 1}, {},
                    self.NOW + 1),
                "refund")

    NOW = 1_000_000.0


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


class CanonicalEventTests(unittest.TestCase):
    """P3 alignment: the daemon must additionally emit glossary-canonical
    grant/progress/terminal/settle/refund events to a JSONL journal,
    without changing any legacy behavior."""

    def _args_with_journal(self, tmpdir):
        a, console = self._base_args()
        import canonical_events
        a.canonical = canonical_events.journal(tmpdir + "/events.jsonl")
        return a, console, tmpdir + "/events.jsonl"

    def _base_args(self):
        a, console = daemon(1.0)
        a._tariffs["t-1"] = 1.0
        ev_charge.console = console
        self.addCleanup(lambda: setattr(ev_charge, "console", None))
        return a, console

    def _events(self, path):
        out = []
        with open(path) as f:
            for line in f:
                out.append(json.loads(line))
        return out

    def test_stopped_session_emits_full_canonical_chain(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, console, path = self._args_with_journal(d)
            gw = FakeGateway([{"state": "running", "seconds": 1},
                              {"state": "done", "seconds": 2,
                               "stopped": True}])
            ev_charge.deliver_energy(a, gw, "t-1", 600, "atomA", {},
                                     session_ref="q-1")
            ev = self._events(path)
            types = [e["type"] for e in ev]
            self.assertEqual(types[0], "grant")
            self.assertEqual(types[-2], "terminal")
            self.assertEqual(types[-1], "settle")
            self.assertIn("progress", types)
            term = [e for e in ev if e["type"] == "terminal"][0]
            self.assertEqual(term["kind"], "completed")
            self.assertEqual(term["seconds_total"], 2)
            self.assertEqual(term["nonce"], "t-1")
            self.assertTrue(term["receipt"].endswith("-STOPPED"))
            settle = [e for e in ev if e["type"] == "settle"][0]
            self.assertEqual(settle["amount_millis"], 2000)

    def test_full_window_is_cap_seconds(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, console, path = self._args_with_journal(d)
            gw = FakeGateway([{"state": "done", "seconds": 6}])
            ev_charge.deliver_energy(a, gw, "t-1", 600, "atomA", {})
            term = [e for e in self._events(path)
                    if e["type"] == "terminal"][0]
            self.assertEqual(term["kind"], "cap_seconds")

    def test_metering_loss_is_lease_expired(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, console, path = self._args_with_journal(d)
            gw = FakeGateway([])
            gw.status = lambda device: {"state": "running", "seconds": 5}
            ev_charge.deliver_energy(a, gw, "t-1", 600, "atomA", {})
            term = [e for e in self._events(path)
                    if e["type"] == "terminal"][0]
            self.assertEqual(term["kind"], "lease_expired")
            self.assertEqual(term["legacy"], "device-timeout-settled")

    def test_refusal_is_failed_terminal(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, console, path = self._args_with_journal(d)
            gw = FakeGateway([])
            gw.trigger = lambda device, seconds, session_ref=None: {
                "triggered": False, "reason": "declined"}
            ev_charge.deliver_energy(a, gw, "t-1", 600, "atomA", {})
            term = [e for e in self._events(path)
                    if e["type"] == "terminal"][0]
            self.assertEqual(term["kind"], "failed")
            self.assertEqual(term["seconds_total"], 0)

    def test_refund_settle_emits_refund_event(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            a, console, path = self._args_with_journal(d)
            state = {"t-1": settled_record()}
            a.state_file = d + "/state.json"
            refund_console = FakeConsole([refund_ticket(400)])
            ev_charge.settle_refunds(a, refund_console, state)
            ev = self._events(path)
            refunds = [e for e in ev if e["type"] == "refund"]
            self.assertEqual(len(refunds), 1)
            self.assertEqual(refunds[0]["amount_millis"], 4000)
            self.assertEqual(refunds[0]["nonce"], "t-1")

    def test_journal_disabled_by_default_is_silent(self):
        a, console = self._base_args()  # no a.canonical at all
        gw = FakeGateway([{"state": "done", "seconds": 1}])
        code, _ = ev_charge.deliver_energy(a, gw, "t-1", 100, "atomA", {})
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
