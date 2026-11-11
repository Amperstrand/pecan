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
