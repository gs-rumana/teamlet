# Security policy

Teamlet runs AI agents that execute commands on the machine it's installed on, so security problems in it can be serious. Thank you for reporting them responsibly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead: go to the repository's **Security** tab and choose **[Report a vulnerability](https://github.com/gs-rumana/teamlet/security/advisories/new)**.

Include what you can of:

- what an attacker can do, and what they need first (network access, a malicious web page, a crafted repository, …)
- steps to reproduce, or a proof of concept
- the Teamlet version and how it runs (desktop app, `pnpm start`, `pnpm dev`)

This is a project maintained in spare time. You can expect an acknowledgement within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release. Please check that the problem still exists there before reporting.

## Scope

Teamlet is a single-user desktop app. Its agents run commands by design, within the access level the user picks for each session. The security model is described in the [README](README.md#security-model).

In scope, for example:

- reaching the API, the WebSocket, or the MCP endpoint from a website (CSRF, DNS rebinding) or from another machine
- a web page or agent output getting the desktop window to run code or reach more than its folder dialog and theme setting
- one lead agent reaching another lead's workers through the MCP endpoint
- reading or writing files through the HTTP API in ways it doesn't intend
- an agent running with more access than the session's level allows, because of how Teamlet configures the provider CLI

Out of scope:

- what an agent does with the access the user granted it (for example, a command run in a *Full access* session)
- vulnerabilities in the `claude` or `codex` CLIs themselves; please report those to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy) or [OpenAI](https://bugcrowd.com/engagements/openai)
- other programs running as you on the same computer, which can already do anything you can
