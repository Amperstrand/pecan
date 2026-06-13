# Product

## Register

product

## Users
Branch operators, mint administrators, and semi-technical deployers who need to provision and run a Cashu mint for a custom unit. They may be comfortable running one installation command, but should not need to edit config files, environment variables, or service definitions by hand.

## Product Purpose
Custom Unit Mint turns a stock `cdk-mintd` plus a custom payment processor into a browser-managed mint lifecycle tool. It guides first-run provisioning, locks immutable mint attributes after setup, starts the mint from generated configuration, supports manual branch settlement, manages keysets and expiry, and gives operators a clear operational dashboard.

## Brand Personality
Calm, exact, operational. The interface should feel like trustworthy infrastructure software: plain language, explicit state, strong defaults, and no decorative ambiguity.

## Anti-references
Avoid marketing-style landing pages, crypto-dashboard spectacle, terminal-only workflows, hidden manual configuration steps, and UI that assumes the operator already knows Cashu/CDK internals.

## Design Principles
- One-command start, browser-first setup.
- Explain irreversible decisions before they are committed.
- Prefer guided defaults over empty expert forms.
- Make system state observable before asking the operator to act.
- Treat lifecycle, accounting, and settlement operations as one coherent tool.

## Accessibility & Inclusion
Use product UI conventions, high-contrast text, keyboard-accessible controls, reduced-motion-safe state changes, and plain language for non-technical operators. Avoid relying on color alone for health or warning states.
