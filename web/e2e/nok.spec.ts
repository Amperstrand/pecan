import { defineWalletSuite } from "./helpers/wallet-suite"

// NOK lane (issue #16): the shared per-currency core (teller + lightning
// deposits, zero-change teller withdraw) for the Charger-Zero pair, so
// every deploy smoke-covers it. The charger chain stays in
// charger-d-nok.spec.ts and the one-way melt refusal in api-smoke (which
// loops every pair). e2e.sh fetches PECAN_NOK_ADMIN_PASSWORD via the pair
// manifest; without it the lane's teller tests fail their apiLogin.
defineWalletSuite({
  currency: "nok",
  consoleBase: "/nok-console",
  password:
    process.env.PECAN_NOK_ADMIN_PASSWORD ?? process.env.PECAN_ADMIN_PASSWORD ?? "",
  name: "NOK wallet E2E (teller + lightning)",
})
