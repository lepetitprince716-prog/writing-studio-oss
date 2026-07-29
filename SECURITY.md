# Security Policy

## Scope

writing-studio is a local-first, single-user application. It is designed to
run on your own machine, for your own use, against your own files. It is not
designed to be exposed to a network, shared between users, or run as a
multi-tenant service. Running it in any of those configurations is outside
the threat model this project defends against.

## No authentication — loopback only

The server binds to `127.0.0.1` only (see `apps/server/src/index.ts`); it
never listens on a network-reachable interface. On top of that, every
request passes through a Host/Origin check (`apps/server/src/local-boundary.ts`)
that rejects any request whose `Host` header is not loopback, and any
`Origin` header that is present but not a loopback origin.

That check is explicitly **not authentication** — the source comment says so
directly. It exists to stop a malicious web page open in your browser from
using DNS rebinding or a crafted `Origin` to talk to the server behind your
back. It does **not** defend against:

- another process running as your own user account on the same machine,
- another user on a shared/multi-user machine that can reach `127.0.0.1`,
- anyone who already has code execution on your machine.

If any of those are in your threat model, do not run writing-studio there
without an additional layer of isolation (a container, a VM, or a dedicated
machine).

## Filesystem sandbox is macOS-only

When the server spawns an external AI CLI to write into your vault, it can
wrap that process in a macOS Seatbelt (`sandbox-exec`) profile
(`apps/server/src/agents/sandbox.ts`) that denies filesystem access by
default and opens only the specific directories the writer needs, explicitly
denying the rest of your vault and the panel's own ports as defense in
depth. The `sandbox-exec` binary itself is looked up at a fixed path
(`/usr/bin/sandbox-exec`) unless you override it with
`WRITING_STUDIO_SANDBOX_EXEC_PATH` — that variable exists mainly for tests,
but it is read in production too, so pointing it at a binary you don't
control would substitute whatever that binary does for the Seatbelt profile
described here.

This sandbox is macOS-only. On any other platform, `sandbox.ts` fails closed:
sandboxed operations throw `required filesystem sandbox is unavailable on
this platform` rather than silently running unsandboxed. Some backends never
go through this wrapper at all:

- The `pi` backend (`apps/server/src/agents/pi.ts`) sets
  `requiresFilesystemSandbox: false` unconditionally and relies entirely on
  the external `pi` CLI's own flags and sandboxing, on every platform
  including macOS.
- The Codex backend (`apps/server/src/agents/codex.ts`) requires the Seatbelt
  wrapper only in its default `seatbelt` mode. Setting
  `WRITING_STUDIO_CODEX_SANDBOX=native` (see README.md) drops the wrapper
  entirely — on macOS as well as elsewhere — and hands isolation over to
  Codex's own permission profile instead. `/api/agents` will report Codex as
  available in `native` mode regardless of whether `sandbox-exec` works, or
  whether you're on macOS at all.

Whatever protections a bypassed CLI does not provide on its own, writing-studio
does not add.

If you are not on macOS, or you are using a backend or mode that does not
request the OS sandbox (`pi`, or Codex in `native` mode), treat that writer
CLI as having the same filesystem access as your own user account.

## External CLIs run with your credentials

writing-studio does not call AI providers directly. It spawns external CLIs
as child processes, and every one of them gets a strict environment
allowlist (`apps/server/src/agents/workspace.ts`): only `PATH`, `HOME`,
`LANG`, `LC_ALL`, `TERM`, `TMPDIR`, and the proxy variables are forwarded
from the server's own environment by default — nothing else leaks through.
Each adapter then names exactly the extra variables its CLI needs:

- The `pi` backend (`apps/server/src/agents/pi.ts`) adds provider API keys
  and tokens it supports (for example `ANTHROPIC_API_KEY`,
  `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`, and similar variables for the
  other providers it can talk to), read from the server's own environment.
- The Claude Code backend (`apps/server/src/agents/claude.ts`) adds
  `CLAUDE_CODE_OAUTH_TOKEN` for headless authentication.
- The Codex, Grok, and OpenCode backends add no credential variables of
  their own; those CLIs read their own stored credentials from files under
  `HOME`, which is already in the allowlist.

Either way, the child process ends up running with your user's real
credentials and whatever privileges that CLI has on your machine. Only
enable backends whose binaries you trust, in the same way you would trust
any other CLI you run locally with your own credentials.

## Reporting a vulnerability

Please report security issues privately using GitHub's private vulnerability
reporting for this repository (the "Security" tab → "Report a
vulnerability"), rather than opening a public issue. Do not include vault
contents or credentials in your report.
