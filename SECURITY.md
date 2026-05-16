# Security Policy

This template handles Slack OAuth tokens and signing secrets, so we take vulnerability reports seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue.** Use one of the private channels below.

- **GitHub Security Advisories** (preferred): open a private report at <https://github.com/TightknitAI/block-kit-builder-template/security/advisories/new>.
- **Email**: send details to <security@tightknit.ai>.

Include enough to reproduce: affected version or commit, the route or flow, expected vs. actual behavior, and any PoC. If a fix is straightforward we may invite you to a private fork.

## What's in scope

- The Worker entry and OAuth flow (`src/worker/`) — token handling, state validation, cookie handling, redirect handling.
- The send pipeline — Block Kit validation, channel resolution, bot-vs-user token selection.
- The Slack events ingress wired through `slack-hono`.

## What's out of scope

- Issues that require an attacker to already control a Slack workspace admin account or the deployer's Cloudflare account.
- Misconfiguration of a fork (e.g. committing `.dev.vars`, leaking secrets in CI logs, deploying without setting `SLACK_SIGNING_SECRET`). We're happy to harden docs if something is easy to get wrong.
- Vulnerabilities in upstream dependencies — report those upstream. If a dep needs a version bump here, a regular PR is fine.

## Supported versions

This is a template, not a long-lived library. Only the `main` branch is supported. Forks are expected to track or pin a commit.

## Response targets

- Initial acknowledgement: within 3 business days.
- Triage and severity assessment: within 7 business days.
- Fix or mitigation for confirmed high-severity issues: within 30 days, coordinated disclosure where appropriate.
