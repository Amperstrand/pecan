#!/usr/bin/env python3
"""Canonical TollGate event journal for the ev-charge daemon.

Additive P3 alignment (see the ecosystem glossary in
tollgate-rs-ai-research-and-experiments/docs/design/glossary.md): the
daemon keeps its legacy ledger and logging untouched, and additionally
appends one JSON line per canonical event to a journal file, so the
deposit pattern becomes observable — and auditable — in the shared
vocabulary:

    grant        a delivery was authorized and triggered
    progress     cumulative accrual observation (units/seconds/cost)
    terminal     final outcome, one of TERMINAL_KINDS
    settle       burn of the receipt-attested amount
    refund       change returned for the un-burnt deposit

Costs are milli-units of money everywhere (`*_millis`); `nonce` is the
ticket id (the idempotency key: one grant ↔ one ticket ↔ one session).
Disabled (silent no-op) when constructed without a path.
"""
import json
import time

TERMINAL_KINDS = (
    "completed",      # stopped before any cap; user or device initiated
    "cap_units",      # units cap reached
    "cap_seconds",    # time cap / granted window exhausted
    "cap_cost",       # money cap reached
    "failed",         # the delivery agent failed before/during delivery
    "revoked",        # the trust-holder revoked the grant
    "lease_expired",  # never exercised / completion never confirmed
)

SCHEMA_VERSION = 1


class NullJournal:
    def grant(self, *a, **k):
        pass

    def progress(self, *a, **k):
        pass

    def terminal(self, *a, **k):
        pass

    def settle(self, *a, **k):
        pass

    def refund(self, *a, **k):
        pass


class CanonicalJournal(NullJournal):
    def __init__(self, path):
        self.path = path

    def _append(self, event):
        event["v"] = SCHEMA_VERSION
        event["at"] = int(time.time() * 1000)
        with open(self.path, "a") as f:
            f.write(json.dumps(event) + "\n")

    def grant(self, nonce, max_seconds, deposit_millis, device, session_ref):
        self._append({"type": "grant", "nonce": nonce,
                      "max_seconds": max_seconds,
                      "deposit_millis": deposit_millis,
                      "device": device, "session_ref": session_ref})

    def progress(self, nonce, units_total, seconds_total, cost_millis_total):
        self._append({"type": "progress", "nonce": nonce,
                      "units_total": units_total,
                      "seconds_total": seconds_total,
                      "cost_millis_total": cost_millis_total})

    def terminal(self, nonce, kind, units_total, seconds_total,
                 cost_millis_total, receipt, legacy=""):
        if kind not in TERMINAL_KINDS:
            raise ValueError(f"non-canonical terminal kind: {kind}")
        self._append({"type": "terminal", "nonce": nonce, "kind": kind,
                      "units_total": units_total,
                      "seconds_total": seconds_total,
                      "cost_millis_total": cost_millis_total,
                      "receipt": receipt, "legacy": legacy})

    def settle(self, nonce, amount_millis):
        self._append({"type": "settle", "nonce": nonce,
                      "amount_millis": amount_millis})

    def refund(self, nonce, amount_millis):
        self._append({"type": "refund", "nonce": nonce,
                      "amount_millis": amount_millis})


def journal(path):
    """Return a CanonicalJournal for `path`, or the silent NullJournal."""
    return CanonicalJournal(path) if path else NullJournal()
