# Product

## Register

product

## Users
Operators of an existing cdk-based Cashu mint who want person-present cash settlement for a custom unit: branch operators and tellers at the counter, and the mint operator who wires the two systems together. They may be comfortable running one installation command and editing their own mint's config file, but should not need to understand cdk internals — the console tells them what to change and verifies it.

## Product Purpose
Pecan (Processor and Ecash Console for Alternative Numeraires) turns one existing `cdk-mintd` into a mint with a cash counter. It implements the "branch" payment method over cdk's stock gRPC payment-processor interface and serves two surfaces: a focused teller for settling wallet-created quotes by quote id, and an operator console whose Mint tab attaches the processor to the mint — setup in two fields, a generated config snippet for the mintd, a live five-point checklist, and an end-to-end self-test. The processor never configures the mint; it verifies and explains. First boot bootstraps a working install with zero interaction (seeded admin account, forced password change); everything else is edited on the running instance and applies live.

## Brand Personality
Calm, exact, operational. The interface should feel like trustworthy infrastructure software: plain language, explicit state, strong defaults, and no decorative ambiguity.

## Anti-references
Avoid marketing-style landing pages, crypto-dashboard spectacle, terminal-only workflows, hidden manual configuration steps, and UI that assumes the operator already knows Cashu/CDK internals.

## Design Principles
- One-command start; no setup wizard — configure the running instance.
- Verify, don't manage: the mint belongs to its operator; the console checks it and hands over exact remedies.
- Explain irreversible decisions before they are committed.
- Prefer guided defaults over empty expert forms.
- Make system state observable before asking the operator to act.

## Accessibility & Inclusion
Use product UI conventions, high-contrast text, keyboard-accessible controls, reduced-motion-safe state changes, and plain language for non-technical operators. Avoid relying on color alone for health or warning states.
