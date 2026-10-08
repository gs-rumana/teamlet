# Changelog

All notable changes to Teamlet are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-09

First public release.

### Added

- A lead agent that splits a task, starts worker agents in parallel through its own MCP tools, collects their reports, and summarizes. Leads and workers can run on Claude Code or Codex, signed in with your own subscriptions.
- Live timelines for the lead and each worker, approval cards for commands, light and dark themes, and a mobile layout.
- Access levels per session (Read only, Edit files, Full access) and a model per agent, both changeable while a session runs. Model lists come from the CLIs themselves.
- Sign-in to Claude and Codex from the app, and several accounts per provider.
- Desktop app for macOS, Windows, and Linux. Its server only listens on `127.0.0.1`, and rejects requests from websites, including through DNS rebinding.

[Unreleased]: https://github.com/gs-rumana/teamlet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gs-rumana/teamlet/releases/tag/v0.1.0
