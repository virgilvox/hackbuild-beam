# hack.build theme

The look, as Vue 3 components.

This folder is deliberately not a package. It lives once at the repo root, and other
hack.build tools adopt it by copying the folder, which is how these tools already
travel. That is why the rule below is absolute:

> **Nothing in `theme/` imports beam code, a store, or anything that knows what a
> laser is. Props in, events out.**

It is enforced in `eslint.config.js`, not left to review. A component that needs to
know whether the beam is armed takes a prop that says so.

## Using it

Import the tokens once, at the app entry, then set the scheme on the root element.

```ts
import "@theme/tokens.css";
import { HbButton, HbPanel } from "@theme/components";
```

```html
<html data-scheme="ink" class="hb-grain">
```

`data-scheme` is `paper` or `ink`. Every component resolves both, because every
component references only the semantic tokens (`--hb-bg`, `--hb-fg`, `--hb-rule`,
`--hb-shadow-color`) and never the palette entries behind them. The studio app
defaults to `ink`: a dark room is the normal operating environment for a laser rig,
and a cream page at full brightness beside a lit beam is a hazard to night vision,
not a neutral choice.

Three surfaces pin themselves to ink in both schemes: the header bar, the run dock
and the console. Those three carry link state, the stop control and the wire log,
and an operator should not have to re-learn where they are when the scheme changes.
They redeclare the semantic tokens locally, so anything dropped into their slots
inherits the dark surface without knowing about it.

## House rules the components obey

- **Zero border radius.** `--hb-radius` is `0` everywhere, on purpose.
- **Hard block shadows, never blur.** A button's press translates by exactly the
  shadow offset and drops the shadow to zero, so the control physically goes down
  onto the page. Offset and translate come from one variable, `--o`, so they cannot
  drift apart.
- **Real controls.** Buttons are `<button>`. Checkboxes are `<input type=checkbox>`
  with `appearance: none`, which keeps the element, its role and its keyboard
  behaviour and takes only the paint. Every labelled control ties `<label for>` to
  the control's `id`.
- **Focus is always visible**, as a 3px pink outline, on everything focusable.
- **No emoji, anywhere.** Icons are inline SVG. No webfont, no CDN.
- **One accent.** Pink is it. Green (`--hb-ok`) means exactly one thing, a captured
  corner, and is spent nowhere else.

## Inventory

| Component | What it is | Key props | Events |
| --- | --- | --- | --- |
| `HbHeaderBar` | Top strip: brand, status chips, actions. Ink in both schemes. | `variant`, `sub` | slots `brand`, `chips`, `actions` |
| `HbWordmark` | "hack" then a pink dot then "build". `beam` variant is the product lockup. | `variant`, `size`, `sub` | none |
| `HbPanel` | Bordered group with a heading, optionally collapsible. | `heading`, `collapsible`, `open`, `flat` | `update:open` |
| `HbFold` | Disclosure, closed by default. For explainers. | `summary`, `open`, `icon` | `update:open` |
| `HbButton` | `default` / `primary` / `danger` / `ghost`, three sizes, block, latched. | `variant`, `size`, `block`, `disabled`, `toggle`, `pressed`, `icon` | `click` |
| `HbField` | Label plus slot, horizontal by default. | `label`, `for`, `stacked`, `controlWidth` | none |
| `HbNumber` | Number with unit suffix, min/max/step. Does not clamp. | `label`, `modelValue`, `unit`, `min`, `max`, `step` | `update:modelValue`, `commit` |
| `HbRange` | Slider with a live value and unit. | `label`, `modelValue`, `min`, `max`, `step`, `unit`, `decimals`, `onDark` | `update:modelValue`, `commit` |
| `HbToggle` | Checkbox as a square that fills accent with a rotated tick. | `label`, `modelValue`, `disabled` | `update:modelValue` |
| `HbSelect` | Labelled native select. | `label`, `modelValue`, `options`, `stacked` | `update:modelValue` |
| `HbKv` | Key/value readout row. `state` colours the value. | `k`, `v`, `unit`, `state` | none |
| `HbNote` | Short muted prose block, typewriter face, pink left rule. | `tone` | none |
| `HbHint` | One sentence with an info marker, under the control it explains. | `marker`, `tone` | none |
| `HbBadge` | Small tag. No state, no dot. | `tone` | none |
| `HbChip` | Status chip with a square dot: `idle` / `on` / `hot` / `danger`. | `label`, `value`, `state`, `live` | none |
| `HbConsole` | Scrolling log. Levels `tx` / `rx` / `err` / `sys` / `sim`, capped, sticky scroll. | `lines`, `max`, `autoScroll`, `height` | `clear` |
| `HbRunDock` | Pinned strip: primary action, pause, stop, progress, inline speed slider. | `primaryLabel`, `running`, `paused`, `progress`, `can*`, `speed*` | `run`, `pause`, `stop`, `update:speed` |
| `HbOverlay` | Modal card on a dimmed page. Backdrop and Escape close it. | `open`, `title`, `width`, `persistent` | `close` |
| `HbIcon` | Inline SVG from the set below. | `name`, `size`, `title` | none |

Non-component modules, all plain TypeScript and all covered by tests:

| Module | What it holds |
| --- | --- |
| `icons.ts` | The icon path data and `HbIconName`. |
| `console.ts` | `HbConsoleLine`, the level union, and `capLines`. |
| `uid.ts` | `hbUid`, for tying a label to a control that was not given an id. |
| `types.ts` | Shapes that cross a component boundary. `<script setup>` cannot export. |

## Behaviours carried over from the originals

Three of these came from the two shipped tools rather than from taste, and the
reasons are in the source next to the code.

- **Console node cap.** Both tools trimmed the log from the front, at 300 and 400
  lines. A running plot logs several times a second for the length of the job, so
  uncapped the browser spends the tail of a long plot laying out scrollback nobody
  is reading, on the same main thread that paces the emitter. The cap here is 400.
- **Sticky, not forced, scroll.** Both tools set `scrollTop = scrollHeight` on every
  line. That is right while you are watching the tail and wrong the moment you
  scroll up to read what just happened. Here the console follows only when it is
  already within a line of the bottom.
- **The run dock is pinned.** From the servo tool: plot, pause and stop live in a
  strip that is always on screen rather than inside a scrolling column. A stop
  control that is a scroll away is not a stop control. The speed slider rides in the
  dock for the same reason: it is the one number reached for mid-plot.

## Icons

`usb`, `bluetooth`, `play`, `pause`, `stop`, `power`, `target`, `crosshair`, `grid`,
`image`, `text`, `pen`, `wave`, `gear`, `warning`, `check`, `x`, `chevron`, `plug`,
`eye`, `info`, `question`, `plus`, `minus`.

Shapes are stroked at weight 2 on a 24 unit grid, with square caps and mitred
joins, so they sit inside the same hard-edged system as everything else. A shape
that reads better solid sets `fill` in its entry.

An icon with no `title` is decorative and is hidden from assistive technology,
because every icon in this set sits beside a real text label. Pass `title` when the
icon genuinely carries the meaning on its own, and it becomes an image with a name.

Adding one is an entry in `icons.ts`. `icons.test.ts` checks that every required
name is present, that path data is well formed, and that nothing strays off the 24
unit grid.

### Attribution

The icon shapes are derived from **Font Awesome Free 6**, used under
**CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>).
Font Awesome Free is by Fonticons, Inc., <https://fontawesome.com>.

Both original tools loaded Font Awesome from a CDN and drew icons as an icon
webfont. This build cannot have either. The single file build must open from
`file://` on a bench with no wifi, so a runtime network fetch is a dependency on the
bench having internet, and an icon whose meaning depends on a font loading is a
button that goes blank when the font does not arrive. The shapes were therefore
redrawn as inline path data on a 24 unit grid and ship inside the bundle. The
attribution above stands regardless, since these are the same glyph designs.

## Fonts

Five faces, each with a job, self hosted from `fonts/` as subset woff2 and all OFL
or Apache licensed. No runtime font fetch, for the same reason as the icons. Every
stack in `tokens.css` declares an honest system fallback, so a missing face degrades
to legible rather than to broken.

| Token | Face | Job |
| --- | --- | --- |
| `--hb-font-mono` | IBM Plex Mono | Labels, buttons, most utility text. |
| `--hb-font-display` | Permanent Marker | The wordmark and panel headings. |
| `--hb-font-prose` | Special Elite | Notes, hints and explainers. |
| `--hb-font-terminal` | VT323 | Live numbers, chips, readouts, the console. |
| `--hb-font-serif` | Libre Baskerville | The one italic tagline. |
