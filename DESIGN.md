---
name: Custom Unit Mint
description: Browser-managed Cashu custom unit mint for provisioning, settlement, health, and keyset operations.
colors:
  bg: "#f7f7f8"
  surface: "#ffffff"
  surface-2: "#fafafa"
  fg: "#0a0a0a"
  fg-muted: "#71717a"
  fg-subtle: "#a1a1aa"
  border: "#e4e4e7"
  border-strong: "#d4d4d8"
  accent: "#2563eb"
  accent-fg: "#ffffff"
  accent-soft: "#2563eb1a"
  success: "#15803d"
  success-soft: "#22c55e24"
  warning: "#b45309"
  warning-soft: "#f59e0b29"
  danger: "#b91c1c"
  danger-soft: "#ef444824"
  dark-bg: "#09090b"
  dark-surface: "#111114"
  dark-surface-2: "#16161a"
  dark-fg: "#fafafa"
  dark-fg-muted: "#a1a1aa"
  dark-fg-subtle: "#71717a"
  dark-border: "#27272a"
  dark-border-strong: "#3f3f46"
  dark-accent: "#3b82f6"
typography:
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "0"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  sm: "6px"
  md: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "9px 14px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "16px 20px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
  pill-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  metric:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
---

# Design System: Custom Unit Mint

## 1. Overview

**Creative North Star: "The Operations Console"**

Custom Unit Mint should feel like trustworthy infrastructure software: calm, exact, operational, and built for repeated use by branch operators and mint administrators. The interface is a product surface, not a marketing surface. It favors dense but readable information, explicit status, and plain language over spectacle.

The system uses a restrained neutral palette with one blue operational accent. Panels, tables, forms, and status pills are intentionally familiar so non-technical or semi-technical users can provision and run the mint without interpreting custom visual metaphors. The UI should make the lifecycle visible: first setup, immutable choices, service health, circulation, keysets, and settlement activity.

It explicitly rejects marketing-style landing pages, crypto-dashboard spectacle, terminal-only workflows, hidden manual configuration steps, and UI that assumes the operator already knows Cashu/CDK internals.

**Key Characteristics:**
- Restrained, high-contrast product UI.
- Dense operational layouts with clear grouping and stable dimensions.
- Plain labels and state names before clever copy.
- One accent used for primary actions, active state, and information emphasis.
- Irreversible or security-sensitive choices are explained before action.

## 2. Colors

The palette is neutral infrastructure gray with a controlled blue accent and semantic status colors. Light and dark modes are both supported through CSS variables, with light mode optimized for daytime operational use.

### Primary
- **Operational Blue** (`#2563eb`): Primary actions, brand mark, active keyset/status emphasis, focus rings, and links. Use sparingly; its job is to guide the operator toward the next real action.
- **Operational Blue Soft** (`#2563eb1a`): Low-emphasis active backgrounds such as waiting, active, and informational pills.

### Neutral
- **Worksurface** (`#f7f7f8`): Page background. It keeps white panels distinct without becoming decorative.
- **Panel White** (`#ffffff`): Cards, setup panels, inputs, and navigation bars.
- **Subtle Panel** (`#fafafa`): Table headers, hover rows, readonly inputs, and low-emphasis chip backgrounds.
- **Ink** (`#0a0a0a`): Primary text and key values.
- **Muted Ink** (`#71717a`): Secondary labels, helper text, table metadata, and inactive navigation.
- **Subtle Ink** (`#a1a1aa`): Tertiary helper text and low-priority detail.
- **Hairline Border** (`#e4e4e7`): Default separators and card strokes.
- **Strong Border** (`#d4d4d8`): Inputs, outline buttons, and controls that need stronger affordance.

### Semantic
- **Settlement Green** (`#15803d`): Paid, saved, success states, and valid setup checks.
- **Expiry Amber** (`#b45309`): Pending, waiting, or review-needed states.
- **Failure Red** (`#b91c1c`): Failed operations, expired keysets, dangerous controls, and blocking errors.

### Named Rules

**The One Accent Rule.** Blue is the only non-semantic accent. Do not introduce extra brand colors for decoration.

**The Status Is Semantic Rule.** Green, amber, and red are only for state. Do not use them to decorate unrelated UI.

**The Surface Contrast Rule.** Panels remain white on light backgrounds and near-black on dark backgrounds. Avoid tinted crypto palettes, gradients, and atmospheric backgrounds.

## 3. Typography

**Display Font:** Inter with system sans fallbacks.
**Body Font:** Inter with system sans fallbacks.
**Label/Mono Font:** JetBrains Mono for identifiers, amounts, URLs, and protocol-like values.

**Character:** Typography is compact, utilitarian, and stable. It should read like operations software: labels are clear, values are scannable, and headings establish task hierarchy without hero styling.

### Hierarchy
- **Headline** (650, `24px`, `1.2`): Page titles, setup headings, and overview hero headings. Use only for the main page task.
- **Section Title** (650, `15px`, `1.5`): Setup sections and compact panel groupings.
- **Card Title** (600, `14px`, `1.5`, `-0.005em`): Card headers and repeated operational panels.
- **Body** (400, `14px`, `1.5`): Main prose, table cells, form text, and dashboard labels.
- **Supporting Text** (400-500, `12-13px`, `1.5`): Helper text, subtitles, status details, and metadata. Use muted colors but keep contrast readable.
- **Mono** (400-500, `11.5-12.5px`, `1.5`): IDs, URLs, amounts where alignment or exactness matters.

### Named Rules

**The No Hero Type Rule.** This is an operational tool. Do not use oversized display type inside dashboards, forms, cards, or setup panels.

**The Data Clarity Rule.** Amounts, IDs, keyset values, and URLs should use tabular or mono treatments when it improves scanning.

## 4. Elevation

Depth is mostly structural: borders, tonal panels, spacing, and low shadows define hierarchy. Shadows exist but remain low and quiet.

### Shadow Vocabulary
- **Surface Low** (`0 1px 2px rgba(0,0,0,.04)`): Default card separation without visible lift.
- **Surface Medium** (`0 1px 3px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.04)`): Login and auth panels only.
- **Dark Surface Low** (`0 1px 2px rgba(0,0,0,.6)`): Dark-mode card separation.
- **Dark Surface Medium** (`0 1px 3px rgba(0,0,0,.5), 0 8px 24px rgba(0,0,0,.4)`): Dark-mode auth panels.

### Named Rules

**The Flat By Default Rule.** Prefer borders and tonal layers. Do not increase shadow blur to make a panel feel important.

**The No Nested Cards Rule.** Cards are for individual repeated items, panels, and forms. Do not put cards inside cards.

## 5. Components

### Buttons

Buttons are compact, familiar controls for clear commands.

- **Shape:** Small radius (`6px`), never pill except for status chips.
- **Primary:** Operational Blue background with white text, `9px 14px` padding, 500 weight.
- **Hover / Focus:** Hover uses a slight brightness lift; focus uses the shared blue soft ring. Active buttons shift down by 1px.
- **Outline:** Transparent background, strong border, foreground text. Hover fills with `surface-2`.
- **Ghost:** Transparent, muted text, no border. Use only for low-risk navigation or cancel-style actions.
- **Danger:** Transparent red text by default, red fill with white text on hover.
- **Disabled:** `0.55` opacity, no transform, no hover brightening.

### Chips

Pills communicate state, not decoration.

- **Style:** `999px` radius, `3px 10px` padding, 12px medium type, and a 6px current-color dot.
- **Active / Waiting:** Blue soft background and blue text.
- **Pending:** Amber soft background and amber text.
- **Paid / Saved:** Green soft background and green text.
- **Failed / Expired:** Red soft background and red text.
- **Inactive:** Neutral background, muted text, visible border.

### Cards / Containers

Cards are operational panels with restrained boundaries.

- **Corner Style:** Medium radius (`10px`).
- **Background:** `surface` on `bg`; `surface-2` only for nested tonal areas such as table headers or review boxes.
- **Shadow Strategy:** Use Surface Low at rest; use Surface Medium only for auth-style focused panels.
- **Border:** Always `1px solid border` for cards and metrics.
- **Internal Padding:** Card headers use `14px 20px`; bodies use `16px 20px`; metrics use `14px 16px`.

### Inputs / Fields

Inputs should feel standard, reliable, and easy to validate.

- **Style:** White surface, strong border, `6px` radius, `9px 12px` padding, 14px type.
- **Focus:** Accent border with `0 0 0 3px` blue soft ring.
- **Help Text:** 12px subtle text under the field.
- **Disabled / Readonly:** `surface-2` background with muted text.
- **Error:** Use alert blocks or native validity messages; do not rely on color alone.

### Navigation

Navigation is a sticky top bar with compact text links and a clear brand mark.

- **Bar:** `surface` background, bottom border, sticky at the top, `14px 28px` padding.
- **Brand Mark:** 28px square, `6px` radius, blue background, white mark.
- **Links:** Muted text at rest; foreground text and `surface-2` background on hover.
- **Mobile:** Preserve wrapping and avoid text overflow. If nav density grows, move to a collapsed menu rather than shrinking text.

### Tables

Tables are for operational records and keyset data.

- **Headers:** 12px uppercase labels with `0.04em` tracking, muted text, and `surface-2` background.
- **Rows:** `14px 20px` cell padding, bottom borders, `surface-2` hover.
- **Identifiers:** Use mono chips for ticket IDs and keyset IDs, with wrapping for long values.

### Setup Form

The setup form is the signature onboarding component.

- **Panel:** Maximum width 900px, `28px` padding, `10px` radius, clear section rhythm.
- **Sections:** 22px vertical form rhythm and 14px internal section gaps.
- **Password Rules:** Inline validation list with neutral "Needed" pills and green "Met" state.
- **Submit State:** The provisioning button is disabled until all irreversible setup requirements are valid and the recovery phrase backup is confirmed.

### Metrics

Dashboard metrics are compact cards for operational scanning.

- **Grid:** `repeat(auto-fit, minmax(210px, 1fr))`.
- **Value:** 22px, 650 weight, wraps safely.
- **Detail:** 12px subtle text for units, health details, and context.

## 6. Do's and Don'ts

### Do:

- **Do** keep interfaces calm, exact, and operational; every element should help setup, settlement, health, or keyset management.
- **Do** use the existing CSS variables before introducing new visual values.
- **Do** use `#2563eb` only for primary actions, links, focus, and active informational state.
- **Do** explain irreversible decisions before the operator commits them.
- **Do** keep form controls and dashboard panels dense but readable, with stable dimensions and responsive grids.
- **Do** use green, amber, and red only for semantic state, paired with text labels.
- **Do** preserve high-contrast text and keyboard-accessible controls.

### Don't:

- **Don't** create marketing-style landing pages for app surfaces.
- **Don't** use crypto-dashboard spectacle: neon palettes, glowing charts, price-ticker styling, glass panels, or decorative gradients.
- **Don't** rely on terminal-only workflows or hidden manual configuration steps.
- **Don't** assume the operator already knows Cashu/CDK internals; prefer plain labels and explicit state.
- **Don't** add decorative side-stripe borders, gradient text, bokeh/orb backgrounds, or oversized hero type.
- **Don't** nest cards inside cards or use cards as decorative page sections.
- **Don't** introduce a second accent color unless it has a clear semantic state role.
