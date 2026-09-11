#!/usr/bin/env bash
# Deposit-rails audit: chains (signet + mutinynet), pairs (EUR + USD),
# rails (onchain + lightning + teller), straight from the OWNED
# infrastructure. Read-only against prod: creates no quotes, sends no
# funds. Repeatable — run after any deploy or chain change.
#
#   scripts/rails-audit.sh
#
# Chain probes ship the JSON payload as a file — nested shell quoting
# has corrupted inline JSON here too many times to ever inline it again.
set -uo pipefail
INR2=root@46.224.104.12
CREDS=/tmp/pecan-bitcoind-creds.txt
PASS=$(grep '^pass:' $CREDS 2>/dev/null | awk '{print $2}')
MPASS=$(grep 'mutinynet-pass:' $CREDS 2>/dev/null | awk '{print $2}')
fail=0
check() { if [ "$2" = ok ]; then echo "  ok    $1 ($3)"; else echo "  FAIL  $1 ($3)"; fail=1; fi }

PAYLOAD=/tmp/rails-audit-rpc.json
printf '%s' '{"jsonrpc":"1.0","id":"a","method":"getblockchaininfo","params":[]}' > $PAYLOAD

probe_chain() { # host port pass — prints "chain blocks headers pruned"
  scp -q $PAYLOAD "$1:/tmp/rails-audit-rpc.json"
  ssh "$1" "curl -s --max-time 8 -u 'pecan-watch:$3' -d @/tmp/rails-audit-rpc.json http://127.0.0.1:$2" </dev/null |
    python3 -c 'import json,sys
try:
  d = json.load(sys.stdin)["result"]
  print(d["chain"], d["blocks"], d["headers"], d["pruned"])
except Exception:
  print("rpc-fail")'
}

echo "== chain backends (owned bitcoinds) =="
# signet: via the inr2 forwarder — the exact path the processor uses.
# mutinynet: direct on net4sats (inr2 forwards zmq only, not rpc).
SIGNET_TIP=0
for chain in "signet|$INR2|38332|$PASS" "mutinynet|net4sats|38333|$MPASS"; do
  IFS='|' read -r name host port pass <<< "$chain"
  out=$(probe_chain "$host" "$port" "$pass")
  [ "$name" = signet ] && SIGNET_TIP=$(python3 -c "o='$out'.split(); print(o[1] if o[1].isdigit() else 0)")
  ok=$(python3 -c "
o = '$out'.split()
print('ok' if len(o) == 4 and o[0] != 'rpc-fail' and o[1].isdigit() and int(o[1]) >= int(o[2]) - 3 else 'bad')")
  check "$name tip tracks headers" "$ok" "$out"
done

echo "== watch wallet (signet, via inr2) =="
printf '%s' '{"jsonrpc":"1.0","id":"w","method":"getwalletinfo","params":[]}' > $PAYLOAD
scp -q $PAYLOAD "$INR2:/tmp/rails-audit-rpc.json"
out=$(ssh "$INR2" "curl -s --max-time 8 -u 'pecan-watch:$PASS' -d @/tmp/rails-audit-rpc.json http://127.0.0.1:38332/wallet/pecan-watch" </dev/null | python3 -c 'import json,sys
try:
  d = json.load(sys.stdin)["result"]
  print(d["walletname"], "PRIVATE" if d["private_keys_enabled"] else "watch-only", "txcount", d["txcount"])
except Exception:
  print("fail")')
ok=$(python3 -c "o='''$out'''.split(); print('ok' if o[0]=='pecan-watch' and o[1]=='watch-only' else 'bad')")
check "watch wallet loaded + watch-only" "$ok" "$out"

echo "== mint pairs =="
for pair in eur usd; do
  methods=$(curl -s --max-time 8 "https://giftcard.cashu.exchange/$pair/v1/info" | python3 -c 'import json,sys
try:
  ms = json.load(sys.stdin)["nuts"]["4"]["methods"]
  print(",".join(m["method"] for m in ms))
except Exception: print("fail")')
  ok=$(python3 -c "print('ok' if all(r in '$methods' for r in ('btc','ln','branch')) else 'bad')")
  check "$pair methods btc+ln+branch" "$ok" "$methods"
  console=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "https://giftcard.cashu.exchange/$pair-console/")
  check "$pair console serves" "$([ "$console" = 200 ] && echo ok || echo bad)" "HTTP $console"
  melt=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 -X POST "https://giftcard.cashu.exchange/$pair/v1/melt/quote/btc" -H "Content-Type: application/json" -d '{"unit":"'$pair'","amount":100,"request":"tb1qtest"}')
  check "$pair one-way (btc melt refused)" "$([ "$melt" -ge 400 ] && echo ok || echo bad)" "HTTP $melt"
done

echo "== cln chain view (signet payer fleet) =="
# The CLN nodes read the chain via PUBLIC esplora — if both providers
# break silently, payments hang. Their blockheight vs the owned
# bitcoind tip catches that before channels time out.
for node in cln-hub-signet cln-vls-signet cln-nostr-signet; do
  out=$(ssh "$INR2" "docker exec $node lightning-cli --network=signet getinfo" </dev/null |
    python3 -c 'import json,sys
try:
  print(json.load(sys.stdin)["blockheight"])
except Exception:
  print("fail")')
  ok=$(python3 -c "print('ok' if '$out'.isdigit() and $SIGNET_TIP - $out <= 2 else 'bad')")
  check "$node tracks tip" "$ok" "cln $out vs bitcoind $SIGNET_TIP"
done

echo "== emergency chain backup (scratch box) =="
# Standby bcli backend (13.140.178.91) — NOT in the hot path, but must
# stay alive: it is the escape hatch if public esplora ever bans us.
# Same pecan-watch rpcauth as net4sats. Payload rewritten: the watch
# wallet probe above overwrote the file on inr2.
printf '%s' '{"jsonrpc":"1.0","id":"a","method":"getblockchaininfo","params":[]}' > $PAYLOAD
scp -q $PAYLOAD "$INR2:/tmp/rails-audit-rpc.json"
out=$(ssh "$INR2" "curl -s --max-time 8 -u 'pecan-watch:$PASS' -d @/tmp/rails-audit-rpc.json http://13.140.178.91:38332" </dev/null |
  python3 -c 'import json,sys
try:
  d = json.load(sys.stdin)["result"]
  print(d["chain"], d["blocks"], d["headers"])
except Exception:
  print("rpc-fail")')
ok=$(python3 -c "
o = '$out'.split()
print('ok' if len(o) == 3 and o[0] != 'rpc-fail' and o[1].isdigit() and int(o[1]) >= int(o[2]) - 3 else 'bad')")
check "scratch box bitcoind alive + synced" "$ok" "$out"

echo "== reserved sat pair =="
sat=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "https://giftcard.cashu.exchange/v1/keys")
check "root /v1 stays unclaimed (404)" "$([ "$sat" = 404 ] && echo ok || echo bad)" "HTTP $sat"

echo
[ $fail -eq 0 ] && echo "RAILS AUDIT: PASS" || echo "RAILS AUDIT: FAIL"
exit $fail
