# Contributing

## Prerequisites

- Node.js >= 22
- pnpm 11.5.2 (this repo pins its package manager via Corepack; run
  `corepack enable` once if you have not already)

## Install

```sh
pnpm install
```

This installs dependencies for all workspaces (`apps/server`, `apps/web`,
`packages/contract`) in one pass.

## Dev loop

```sh
pnpm dev
```

Runs the server and the web client together in watch mode. `apps/server` and
`apps/web` also each have their own `dev`/`test`/`typecheck` scripts if you
want to work on one side only — see each `package.json` for the full list,
or filter from the root, e.g. `pnpm --filter @writing-studio/server test`.
`packages/contract` has `test`/`typecheck` but no `dev` script — it's a
types-and-schemas package with no server to watch.

## `pnpm verify`

Before opening a pull request, run:

```sh
pnpm verify
```

This runs three stages in sequence, and stops at the first one that fails:

1. `pnpm typecheck` — TypeScript project checks across all workspaces.
2. `pnpm build` — production build for each workspace that has one.
3. `pnpm test` — the full test suite across all workspaces.

CI's `macos-14` lane runs this same `pnpm verify` command — a clean local
run is a good predictor of a clean run on that lane. A second, cheaper
`ubuntu-latest` lane also runs on every push/PR, but only `pnpm -r typecheck`
plus the contract and web test suites; it does not build and does not run
the server's test suite, since the server's Seatbelt-sandbox tests need
macOS.

## Workspace layout

| Path                 | What it is                                                   |
| -------------------- | ------------------------------------------------------------- |
| `apps/server`        | Fastify + SQLite backend; vault access, AI CLI adapters        |
| `apps/web`           | React/Vite three-pane editor and 3D relationship graph         |
| `packages/contract`  | zod schemas and types shared by server and web                |

## Sandbox-gated server tests

A subset of `apps/server` tests exercise the macOS filesystem sandbox
(Seatbelt / `sandbox-exec`) directly. Those tests skip themselves on any
platform other than macOS, or when `sandbox-exec` is not usable in the
current environment. A green test run that reports some tests as skipped is
expected on Linux, Windows, or a macOS machine without a usable
`sandbox-exec` — it does not mean coverage was lost, only that the
platform-specific tests were not applicable.

A separate, unrelated set of tests skip on an opt-in environment variable
rather than a platform check — see `WRITING_STUDIO_LOCAL_VAULT` under the
Tests section of the README for what it does and which files read it.

## `packages/contract` is the shared source of truth

Both `apps/server` and `apps/web` depend on `@writing-studio/contract` for
their request/response schemas and shared types. Because both sides consume
it directly, changes here must be additive: prefer adding new optional
fields, new schemas, or new exported helpers over changing or removing
existing ones. If a breaking change to a schema is genuinely necessary, call
it out explicitly in your pull request description and update every
consumer in the same change.
