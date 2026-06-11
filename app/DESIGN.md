---
version: alpha
name: 'Cerida Design System'
description: "Typography baseline relies on Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif for hero headline (e.g. 'own the power of your money')."
colors:
  darkest-base: '#0b041a'
  deep-navy: '#191322'
  light-purple: '#855bfb'
  positive-green-bright: '#35df8d'
  brand-purple: '#7132f5'
  inverted-white: '#ffffff'
  near-black: '#101114'
  muted-slate: '#686b82'
  light-grey: '#f5f5f5'
  pure-white: '#ffffff'
  surface-lavender: '#f6f5f9'
  error-red: '#d11d45'
  positive-green: '#08844f'
  border-subtle: '#dedee5'
  dimmed-grey: '#9497a9'
typography:
  display-hero:
    fontFamily: 'Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '58px'
    fontWeight: '400'
    lineHeight: '66px'
    letterSpacing: '-4px'
  display-large:
    fontFamily: 'Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '48px'
    fontWeight: '400'
    lineHeight: '56px'
    letterSpacing: '-3.2px'
  display-medium:
    fontFamily: 'Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '36px'
    fontWeight: '400'
    lineHeight: '44px'
    letterSpacing: '-2px'
  heading-1:
    fontFamily: 'Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '24px'
    fontWeight: '500'
    lineHeight: '32px'
    letterSpacing: '0px'
  heading-2:
    fontFamily: 'Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '20px'
    fontWeight: '500'
    lineHeight: '28px'
    letterSpacing: '0px'
  heading-3:
    fontFamily: 'Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '18px'
    fontWeight: '500'
    lineHeight: '26px'
    letterSpacing: '0px'
  body-default:
    fontFamily: 'Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '14px'
    fontWeight: '400'
    lineHeight: '24px'
  body-medium:
    fontFamily: 'Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '16px'
    fontWeight: '400'
    lineHeight: '22px'
  label:
    fontFamily: 'Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif'
    fontSize: '12px'
    fontWeight: '500'
    lineHeight: '16px'
    letterSpacing: '0.5px'
  code-mono:
    fontFamily: 'ui-monospace'
    fontSize: '12px'
    fontWeight: '400'
    lineHeight: '14.4px'
rounded:
  radius-sm: '8px'
  radius-md: '12px'
  radius-lg: '16px'
  radius-xl: '20px'
  radius-2xl: '24px'
  radius-pill: '9999px'
spacing:
  space-1: '4px'
  space-2: '8px'
  space-3: '12px'
  space-4: '16px'
  space-5: '20px'
  space-6: '24px'
  space-10: '40px'
  space-12: '48px'
  space-14: '56px'
  space-18: '72px'
---

## Overview

Typography baseline relies on Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif for hero headline (e.g. 'own the power of your money').

This system uses a 8px base grid with scale values 4, 8, 12, 16, 20, 24, 40, 48, 56, 72.

**Signature traits:**

- Core token rhythm: Token evidence indicates consistent color, spacing, and radius rhythm across visible UI.

## Colors

The palette uses 18 validated color tokens across 2 theme profiles. Semantic roles stay attached to observed usage so generation agents can choose accents without inventing new color meaning.

**Semantic naming:**

- **action-text** maps to `brand-purple`: Role "text" is grounded by usage context "Primary CTA buttons (Sign up, Try Kraken), brand links, focus outlines, selected card borders".
- **surface-background** maps to `surface-lavender`: Role "background" is grounded by usage context "Hero section background, page-level surface tint".
- **border-text** maps to `muted-slate`: Role "text" is grounded by usage context "Secondary/supporting text, dividers, nav hover states, muted labels".
- **surface-border** maps to `dimmed-grey`: Role "border" is grounded by usage context "Dimmed text, badge neutral backgrounds, card outlines, legend items".

### Dark Theme

### Text Scale

- **Brand Purple** (#7132f5): Primary CTA buttons, brand links, focus outlines in dark sections. Role: text. {authored: rgb(113, 50, 245), space: rgb}
- **Inverted White** (#ffffff): Primary text on dark backgrounds, headings in dark sections. Role: text. {authored: rgb(255, 255, 255), space: rgb}
- **Near Black** (#101114): Text in light-on-dark contexts, shared token. Role: text. {authored: rgb(16, 17, 20), space: rgb}

### Interactive

- **Muted Slate** (#686b82): Dividers, muted text on dark surfaces. Role: border. {authored: rgb(104, 107, 130), space: rgb, alpha: 0.04}

### Surface & Shadows

- **Darkest Base** (#0b041a): Deepest dark surface, footer dark background. Role: background. {authored: rgb(11, 4, 26), space: rgb}
- **Deep Navy** (#191322): Dark section background (Pro product section). Role: background. {authored: rgb(25, 19, 34), space: rgb}
- **Light Purple** (#855bfb): Lighter purple variant for hover/active states on dark surfaces. Role: background. {authored: rgba(133, 91, 251, 0.16), space: rgb, alpha: 0.16}
- **Positive Green Bright** (#35df8d): Positive/gain indicators on dark backgrounds. Role: background. {authored: rgb(53, 223, 141), space: rgb}

### Light Theme

### Text Scale

- **Brand Purple** (#7132f5): Primary CTA buttons (Sign up, Try Kraken), brand links, focus outlines, selected card borders. Role: text. {authored: rgb(113, 50, 245), space: rgb}
- **Error Red** (#d11d45): Error/negative states, destructive actions, loss indicators. Role: text. {authored: rgb(209, 29, 69), space: rgb}
- **Muted Slate** (#686b82): Secondary/supporting text, dividers, nav hover states, muted labels. Role: text. {authored: rgb(104, 107, 130), space: rgb, alpha: 0.04}
- **Near Black** (#101114): Primary body text, headings, nav links, footer text. Role: text. {authored: rgb(16, 17, 20), space: rgb}
- **Positive Green** (#08844f): Positive/success states, positive button variants, gain indicators. Role: text. {authored: rgb(8, 132, 79), space: rgb}

### Interactive

- **Border Subtle** (#dedee5): Hairline dividers, input borders, card separators. Role: border. {authored: rgb(222, 222, 229), space: rgb}
- **Dimmed Grey** (#9497a9): Dimmed text, badge neutral backgrounds, card outlines, legend items. Role: border. {authored: rgb(148, 151, 169), space: rgb, alpha: 0.08}

### Surface & Shadows

- **Light Grey** (#f5f5f5): Subtle surface fills, hover states on neutral elements. Role: background. {authored: rgb(245, 245, 245), space: rgb}
- **Pure White** (#ffffff): Card surfaces, nav background, inverted text on dark sections. Role: background. {authored: rgb(255, 255, 255), space: rgb}
- **Surface Lavender** (#f6f5f9): Hero section background, page-level surface tint. Role: background. {authored: rgb(246, 245, 249), space: rgb}

## Typography

Typography uses Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif, Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif, Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif, ui-monospace across extracted hierarchy roles. Keep hierarchy mapped to these token rows before adding decorative type styles.

Mixes Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif and Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif and Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif and ui-monospace for visual contrast. Weight range spans regular, medium. Sizes range from 12px to 58px.

### Type Scale Evidence

| Role | Font | Size | Weight | Line Height | Letter Spacing | Stack / Features | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hero headline (e.g. 'Own the power of your money') | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | 58px | 400 | 66px | -4px | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Large display headings, brand statements | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | 48px | 400 | 56px | -3.2px | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Section display headings | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | 36px | 400 | 44px | -2px | Financier Display, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Primary section headings | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | 24px | 500 | 32px | 0px | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Sub-section headings, card titles | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | 20px | 500 | 28px | 0px | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Tertiary headings, stat labels | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | 18px | 500 | 26px | 0px | Söhne, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Primary body text, nav items, descriptions | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | 14px | 400 | 24px | normal | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Slightly larger body text, input placeholders | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | 16px | 400 | 22px | normal | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Labels, badges, captions, tags | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | 12px | 500 | 16px | 0.5px | Kraken-Product, IBM Plex Sans, Helvetica, Arial, sans-serif | Extracted token |
| Code snippets, monospaced data values | ui-monospace | 12px | 400 | 14.4px | normal | ui-monospace, Menlo, Monaco, Consolas, Courier New, monospace | Extracted token |

## Layout

Responsive system uses 4 breakpoint tier(s): mobile, tablet, desktop, wide.

### Responsive Strategy

- **mobile (400-1440px)**: Constrain layout for small viewports and prioritize vertical stacking.
- **tablet (640-1023px)**: Increase spacing and column structure for medium-width viewports.
- **desktop (>= 1024px)**: Expand layout density and horizontal composition for wide viewports.
- **wide (>= 1441px)**: Stretch composition with generous gutters and wider layout spans.

### Spacing System

| Token    | Value | Px  | Notes                   |
| -------- | ----- | --- | ----------------------- |
| space-1  | 4px   | 4   | Extracted spacing token |
| space-2  | 8px   | 8   | Extracted spacing token |
| space-3  | 12px  | 12  | Extracted spacing token |
| space-4  | 16px  | 16  | Extracted spacing token |
| space-5  | 20px  | 20  | Extracted spacing token |
| space-6  | 24px  | 24  | Extracted spacing token |
| space-10 | 40px  | 40  | Extracted spacing token |
| space-12 | 48px  | 48  | Extracted spacing token |
| space-14 | 56px  | 56  | Extracted spacing token |
| space-18 | 72px  | 72  | Extracted spacing token |

## Elevation & Depth

Keep depth flat unless validated shadow or interaction evidence appears in the extraction payload. Do not invent shadows beyond this evidence boundary.

### Shadow Evidence

| Shadow Token | Layers | Details                     |
| ------------ | ------ | --------------------------- |
| n/a          | 0      | No validated shadow payload |

### Interaction Signals

| Theme | Signal | Evidence |
| --- | --- | --- |
| Light | backdrop-filter | blur(24px) ; blur(64px) |
| Light | outline-style | solid |
| Light | outline-color | rgb(16, 17, 20) ; rgb(104, 107, 130) ; rgb(255, 255, 255) |
| Light | outline-width | 3px ; 2px ; 0px |
| Light | outline-offset | 0px ; -2px ; 2px |
| Light | transform | matrix(1, 0, 0, 1, 0, 0) ; matrix(1.01085, 0, 0, 1.01085, -1.46218, 8.21578) ; matrix(1, 0, 0, 1, -295, -180) |
| Dark | backdrop-filter | blur(24px) ; blur(64px) |
| Dark | outline-style | solid |
| Dark | outline-color | rgb(16, 17, 20) ; rgb(104, 107, 130) ; rgb(255, 255, 255) |
| Dark | outline-width | 3px ; 2px ; 0px |
| Dark | outline-offset | 0px ; -2px ; 2px |
| Dark | transform | matrix(1, 0, 0, 1, 0, 0) ; matrix(1.02384, 0, 0, 1.02384, 0.392667, -0.0865287) ; matrix(1, 0, 0, 1, -295, -180) |

## Shapes

Shape language maps directly to rounded tokens. Keep component corners consistent with the role mapping below before introducing bespoke geometry.

### Radius Roles

| Token       | Value  | Px   | Role Mapping         |
| ----------- | ------ | ---- | -------------------- |
| radius-sm   | 8px    | 8    | Control corner       |
| radius-md   | 12px   | 12   | Control corner       |
| radius-lg   | 16px   | 16   | Card corner          |
| radius-xl   | 20px   | 20   | Card corner          |
| radius-2xl  | 24px   | 24   | Large surface corner |
| radius-pill | 9999px | 9999 | Large surface corner |

### Geometry Evidence

| Radius Token | Shape  | Units |
| ------------ | ------ | ----- |
| radius-sm    | 8px    | px    |
| radius-md    | 12px   | px    |
| radius-lg    | 16px   | px    |
| radius-xl    | 20px   | px    |
| radius-2xl   | 24px   | px    |
| radius-pill  | 9999px | px    |

## Components

(none detected)

## Do's and Don'ts

Guardrails protect Core token rhythm without adding unsupported visual claims.

| Do | Don't |
| --- | --- |
| Do maintain consistent spacing using the base grid | Don't make unsupported claims about absent visual features |
| Do maintain WCAG AA contrast ratios (4.5:1 for normal text) | Don't mix rounded and sharp corners in the same view |
| Do use the primary color only for the single most important action per screen |  |
| Do verify evidence before writing new design-system guidance |  |

## Responsive Evidence

### Breakpoints

| Name | Width | Key Changes |
| --- | --- | --- |
| Mobile | <= 319px | (max-width: 319px) |
| Mobile | <= 359px | (max-width: 359px) |
| Mobile | <= 370px | (max-width: 370px) |
| Mobile | <= 375px | (max-width: 375px) |
| Mobile | <= 425px | (max-width: 425px) |
| Mobile | <= 450px | (max-width: 450px) |
| Mobile | <= 530px | only screen and (max-width: 530px) |
| Mobile | <= 599px | (max-width: 599px) |
| Mobile | <= 600px | only screen and (max-width: 600px) |
| Mobile | <= 639px | (max-width: 639px) |
| Mobile | <= 640px | (max-width: 640px) |
| Mobile | <= 767px | (max-width: 767px) |
| Breakpoint 13 | <= 768px | (max-width: 768px) |
| Breakpoint 14 | <= 896px | only screen and (max-height: 425px) and (max-width: 896px) and (orientation: landscape) |
| Breakpoint 15 | <= 950px | (max-width: 950px) |
| Breakpoint 16 | <= 959.95px | (max-width: 959.95px) |
| Breakpoint 17 | <= 980px | (max-width: 980px) |
| Breakpoint 18 | <= 1024px | (max-width: 1024px) |
| Breakpoint 19 | <= 1025px | only screen and (max-width: 1025px) |
| Breakpoint 20 | <= 1050px | (max-width: 1050px) |

## Agent Prompt Guide

### Example Component Prompts

- Create button component using validated primary color role and spacing tokens.
- Create card component with mapped radius role and evidence-backed elevation.
- Create form input component using inferred typography hierarchy and border roles.

### Iteration Guide

1. Start with extracted palette and typography roles only.
2. Map spacing and radius directly from token tables before visual polish.
3. Apply component patterns one section at a time and compare against source intent.
4. Keep elevation claims tied to explicit evidence in output.
5. Iterate with smallest diffs and re-check section hierarchy after each change.
