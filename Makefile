.PHONY: demo farm-demo

# Full live demo on this Mac's screen: fund the NOK wallet at the teller
# counter, approve the deposit in the admin console, melt to charger D and
# watch it deliver. Two visible browser windows; Ctrl+C closes.
demo:
	scripts/demo.sh

# Live EGG demo on this Mac's screen: buy today's eggs (autopay settles
# the signet invoice), redeem at the counter, settle as the operator.
# Works any time of day — the vending machine has no time gate.
farm-demo:
	scripts/farm-demo.sh
