# Ledger reconciliation core: compare the mint's ecash ledger (cdk sqlite)
# against the teller's cash movements (pecan tickets.json) and report drift.
#
# The one-way mint has two dangerous inconsistencies this catches early:
#   * ticket PAID but melt quote not settled  -> cash out, ecash still alive
#     (double-spend against the mint)
#   * melt quote settled but ticket not PAID  -> ecash burned, no payout
#     (user loss)
# plus housekeeping signals: paid-but-unclaimed deposits, stale pending
# tickets past quote expiry.
#
# Usage: python3 reconcile-core.py <mint.sqlite> <tickets.json> [-v]
# Exit 0 = clean, 1 = drift. Run read-only; safe any time.
# Called by scripts/reconcile.sh (local, EUR, via ssh stdin) and by
# /opt/pecan-tools/reconcile-server.sh (hourly cron daemon, both pairs).
import json, sqlite3, sys, time
db_path, tickets_path = sys.argv[1], sys.argv[2]
verbose = len(sys.argv) > 3 and sys.argv[3] == '-v'
db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
tickets = json.load(open(tickets_path))['tickets']
now = int(time.time())
problems = 0

def flag(msg):
    global problems
    problems += 1
    print(f'  DRIFT: {msg}')

# ---- outgoing: melt quotes vs MELT tickets --------------------------------
melt_quotes = {r['id']: r for r in db.execute(
    "SELECT id, amount, unit, state, paid_time, expiry FROM melt_quote WHERE payment_method='branch'")}
melt_tickets = {t['quote_id']: t for t in tickets.values() if t['kind'] == 'outgoing'}
print(f"outgoing: {len(melt_tickets)} tickets vs {len(melt_quotes)} melt quotes")
for qid, t in melt_tickets.items():
    q = melt_quotes.get(qid)
    if q is None:
        flag(f"ticket {t['id']} ({t['status']}) has no melt quote — expired unfunded?")
        continue
    ticket_paid, quote_state = t['status'] == 'paid', q['state']
    proofs = db.execute(
        'SELECT count(*), coalesce(sum(amount),0) FROM proof WHERE quote_id=? AND operation_kind=\'melt\'',
        (qid,)).fetchone()
    if ticket_paid and quote_state != 'PAID':
        flag(f"{qid[:13]}: ticket PAID but mint quote {quote_state} — cash out, ecash alive")
    if quote_state == 'PAID' and not ticket_paid:
        flag(f"{qid[:13]}: mint quote PAID but ticket {t['status']} — burned without payout")
    if q['expiry'] < now and quote_state not in ('PAID',) and t['status'] in ('waiting','pending'):
        if proofs[0] > 0:
            flag(f"{qid[:13]}: quote EXPIRED, ticket still {t['status']}, but {proofs[1]} units of proofs are burned — value destroyed without payout")
        else:
            print(f"  note: {qid[:13]}: expired quote, ticket still {t['status']} (nothing burned; teller never settled)")
    if verbose:
        print(f"    {qid[:13]} ticket={t['status']:7} quote={quote_state:7} proofs={proofs[0]}x{proofs[1]}")

# ---- incoming: mint quotes vs MINT tickets --------------------------------
mint_tickets = {t['quote_id']: t for t in tickets.values() if t['kind'] == 'incoming'}
print(f"incoming: {len(mint_tickets)} tickets")
for qid, t in mint_tickets.items():
    q = db.execute('SELECT amount, amount_paid, amount_issued, expiry FROM mint_quote WHERE id=?', (qid,)).fetchone()
    if q is None:
        continue
    if t['status'] == 'paid' and q['amount_paid'] == 0:
        flag(f"{qid[:13]}: ticket paid but mint says nothing was paid — cash in, no ecash backing")
    if q['amount_paid'] > q['amount_issued']:
        claimable = q['amount_paid'] - q['amount_issued']
        age = now - q['expiry']
        suffix = f' (EXPIRED {age}s ago — value stranded at mint)' if q['expiry'] < now else ''
        print(f"  note: {qid[:13]}: {claimable} {t['unit']} paid but unclaimed by wallet{suffix}")

# ---- orphans both directions ----------------------------------------------
for qid in melt_quotes:
    if qid not in melt_tickets and melt_quotes[qid]['state'] != 'UNPAID':
        print(f"  note: melt quote {qid[:13]} ({melt_quotes[qid]['state']}) has no ticket")
for qid in mint_tickets:
    pass  # mint quotes without tickets are the wallet-less deposits; fine

spent = db.execute("SELECT count(*) FROM proof WHERE state='SPENT'").fetchone()[0]
print(f'proof ledger: {spent} spent proofs')
print(f'RESULT: {problems} drift' + ('s' if problems != 1 else '') if problems else 'RESULT: clean')
sys.exit(1 if problems else 0)
