// Windows-specific helpers in server/util.ts, tested on any platform.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launch, shellCommand, shimTarget } from "../server/util.ts";

// What npm (cmd-shim) writes to %APPDATA%\npm for a JavaScript CLI.
const JS_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`;

// …and for a CLI whose bin is a native executable.
const EXE_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
`;

// Older npm versions wrote this form.
const OLD_SHIM = String.raw`@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\node_modules\@openai\codex\bin\codex.js" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\node_modules\@openai\codex\bin\codex.js" %*
)
`;

test("finds the file behind an npm .cmd shim", () => {
  assert.equal(shimTarget(JS_SHIM), String.raw`node_modules\@openai\codex\bin\codex.js`);
  assert.equal(shimTarget(EXE_SHIM), String.raw`node_modules\@anthropic-ai\claude-code\bin\claude.exe`);
  assert.equal(shimTarget(OLD_SHIM), String.raw`node_modules\@openai\codex\bin\codex.js`);
  assert.equal(shimTarget("@echo off\r\nclaude.exe %*\r\n"), undefined);
});

test("runs JavaScript CLIs with node and others directly", () => {
  const [command, args] = launch("/x/codex.js", ["exec"]);
  assert.match(command, /node(\.exe)?$/i);
  assert.deepEqual(args, ["/x/codex.js", "exec"]);
  assert.deepEqual(launch("/x/claude.exe", ["--version"]), ["/x/claude.exe", ["--version"]]);
});

test("writes sign-in commands for the user's shell", () => {
  const env = { CLAUDE_CONFIG_DIR: "/home/me/claude work", CODEX_HOME: undefined };
  assert.equal(
    shellCommand(["claude", "auth", "login"], env, "darwin"),
    "env -u CODEX_HOME CLAUDE_CONFIG_DIR='/home/me/claude work' claude auth login",
  );
  assert.equal(
    shellCommand(["claude", "auth", "login"], { CLAUDE_CONFIG_DIR: String.raw`C:\Users\me\it's`, CODEX_HOME: undefined }, "win32"),
    String.raw`$env:CLAUDE_CONFIG_DIR = 'C:\Users\me\it''s'; Remove-Item Env:CODEX_HOME -ErrorAction Ignore; claude auth login`,
  );
});
