# coco 2.0.0 snapshot migration — measured surface (2026-11-11)

Pin: upstream master 2d6aa58 (post-#613), packed as vendor tarballs
2.0.0 + SHA256SUMS. npm override forces @cashu/cashu-ts 5.0.0-rc.9
app-wide (coco 2.0.0 peers rc.4 EXACTLY — rc-to-rc exact peer is
standing friction; single copy avoids Amount instanceof splits).

tsc -b gates the following migration work (all predicted by
FORK.md taxonomy + cashu-cf ISSUE-110 assessment):

1. FORK-ERA CUSTOM-METHOD PLATFORM (src/lib/coco/branch-methods.ts,
   coco-wallet.ts): registerMeltMethod/registerMintMethod,
   private keyRingService access, deep imports
   @cashu/coco-core/operations/{melt,mint} — all gone/changed in 2.0.
   Port target: upstream's open MeltMethodDefinitions + handler
   architecture. This is the teller-console branch-settlement
   integration — the real work of this migration.
2. 2.0 Amount model: CreateMintQuoteInput wants Amount objects where
   call sites pass number (coco-wallet.ts:325 class of errors).
3. cashu-ts peer exactness (above).

Blocked-by-none: the NUT-04 cf finding does NOT gate pecan (cdk twins
serve accounting fields; verified against cdk v0.18.2 source).

## Port recon (2026-11-11, second pass)

- branch-methods.ts is ALREADY declaration-merging MeltMethodDefinitions
  (fork 1.0.18 adopted the pattern). Its tsc errors are import-path only:
  2.0's exports map serves ".", "./plugin", "./adapter" — no
  ./operations/{melt,mint}. Interfaces exist in index types; retarget the
  declare-module specifier to "@cashu/coco-core" (or plugin surface) —
  mechanical.
- coco-wallet.ts is NOT mechanical: no public
  registerMeltMethod/registerMintMethod/MeltMethodHandler in 2.0's
  d.ts, and keyRingService stays private. The ~10 registration sites +
  keyring access must move to the plugin architecture (dist/plugin.d.ts)
  or upstream's handler wiring. Design work, ~the teller integration.
- Amount sites (coco-wallet.ts:325 class): number -> Amount conversions
  at quote-create call sites.

## Port pattern FOUND (2026-11-11, research #1)

Upstream's own answer for custom methods is the plugin architecture:
cocod consumes `coco-cashu-plugin-npc` (a separate plugin package) via
runtime; coco 2.0 exports the full Plugin surface from
`@cashu/coco-core/plugin` (Plugin, PluginContext, ServiceMap,
PluginExtensions). Port shape for pecan: turn branch-methods.ts into a
small in-repo plugin passed to initializeCoco({ plugins: [...] }) —
NOT Manager-internal registration (registerMeltMethod/keyRingService
are gone by design). Next concrete step: read
coco-cashu-plugin-npc's source as the reference implementation and
mirror its structure for the branch/teller methods.
