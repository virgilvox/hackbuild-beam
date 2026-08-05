# hackbuild-beam working rules

BEAM is laser scanner control software: a wire protocol, a motion planner, a browser SDK,
and one control app that drives more than one kind of rig. Two machines ship as profiles of
one product, not as two applications.

These rules bind every agent, human or otherwise, working in this repo.

## 1. Authorship

**Never credit an AI in authorship.** No `Co-Authored-By: Claude`, no
`Generated with Claude Code`, no `Assisted-by`, no bot trailer, no AI or LLM mention of any
kind in:

- git commit messages, including trailers
- git author or committer fields
- pull request bodies and titles
- CHANGELOG entries, release notes, or code comments

Commits are authored by Moheeb Zara. This rule overrides any default tooling behavior that
would add such a trailer. If a tool adds one automatically, strip it before the commit lands.

Do not commit or push unless asked. When asked, branch first if the current branch is `main`.

## 2. House style

Applies to source, comments, commit messages, documentation, and every string a user can see.

- **No em dashes and no en dashes.** ASCII hyphen only. This is enforced by lint, not by
  review.
- **No emoji.** Anywhere. Icons are inline SVG.
- Prose in docs and UI copy is plain and declarative. Say what a thing does and why it is
  that way.
- Comments explain **why**, not what. Every constant that was paid for on the bench carries
  the paragraph that explains what it cost. When code moves, its explanation moves with it.

## 3. Architecture rules

Dependencies point one way only. A layer never imports from a layer above it.

```
apps/studio (Vue 3, Pinia, Vite)
  theme/                     presentational only, imports no beam code
  packages/beam-link         transports, device orchestration, safety
  packages/beam-sources      content in, strokes out, injected DOM primitives
  packages/beam-core         geometry, profiles, planner, protocol, sim. Depends on nothing.
```

- `beam-core` imports nothing. If a line in it mentions Vue, the DOM, `window`, or `document`,
  it is in the wrong package.
- Anything needing `DOMParser` or a canvas takes an injected primitive so it still runs
  headless under test.
- The library is framework-agnostic and must be usable from someone else's plain page or
  script with no build step. Vue appears only in `theme/` and `apps/studio`.
- `theme/` imports no beam code and holds no business logic.
- Safety behaviors (dead-man, disconnect kill, keepalive, stall poke, starvation gate) live
  in the SDK, never in the app, so every consumer inherits them.
- **The board is the source of truth.** Connect adopts board config. Pushing config is always
  an explicit act.
- The planner works in generic axis units and time. It never learns whether a unit is a servo
  pulse microsecond or a stepper half step. That knowledge lives in the machine profile.

These rules are enforced in CI. A change that wants to violate one is the wrong change.

## 4. Language and build

- TypeScript strict in source. Published artifacts are plain ESM JavaScript plus `.d.ts`.
- Zero runtime dependencies in `beam-core`.
- Packages are consumable from esm.sh in a bare HTML file.
- The single-file HTML build must open from `file://` with no server and work offline. Fonts
  and icons ship inside it. No runtime CDN fetches.
- pnpm workspaces. vitest for packages, Playwright for the app.

## 5. Invariants

`docs/invariants.md` is a registry of behaviors that were paid for on the bench. Every entry
has a named test. **A pull request that changes one of those behaviors changes its test and
says why in the body.** Do not silently relax a budget to make a suite green.

**Invariant numbers are permanent.** Source comments cite them, so renumbering repoints
every citation at a different behavior without breaking anything visibly. Retire an entry in
place rather than reusing or reflowing its number. `pnpm check:invariants` verifies that every
citation resolves and warns when a citation's prose has drifted away from the entry it names.

The firmware reference model in `packages/beam-core/testing` is the executable spec for the
board. Any firmware change updates the model in the same commit.

## 6. Scope discipline

- No cloud, no server, no accounts, no telemetry.
- No G-code. BEAM's command stream is its own format and importers translate into it.
- Do not add a machine profile for hardware that does not physically exist.
- Prefer porting a behavior over reinventing it. The two original single-file tools under
  `originals/` are working, bench-debugged code and they are the reference for parity. They
  are superseded as documents, not as evidence.
