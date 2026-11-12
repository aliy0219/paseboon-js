/**
 * OS login prompt for protected settings, per platform. Always `execFile`
 * (never a shell) with fixed arguments: no user input reaches a command line.
 *
 *   macOS    paseboon-auth helper (LocalAuthentication, deviceOwnerAuthentication):
 *            Touch ID with the account password as fallback.
 *   Windows  Windows Hello via PowerShell WinRT UserConsentVerifier.   UNTESTED
 *   Linux    `pkexec /bin/true` through the desktop polkit agent.      UNTESTED
 *            polkit's default rule asks for an ADMIN password.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { Result, mapExitCode } from '../core/authgate.js';

export const AUTH_REASON = 'Paseboon JS: change settings';
export const PROMPT_TIMEOUT_MS = 120_000; // an unanswered prompt denies, it never opens
const CHECK_TIMEOUT_MS = 10_000;

export function helperPath({ packaged, resourcesPath, appRoot }) {
  return packaged
    ? path.join(resourcesPath, 'paseboon-auth')
    : path.join(appRoot, 'build', 'native', 'paseboon-auth');
}

// Windows: one fixed script; $env:PASEBOON_AUTH_MODE selects check vs prompt.
// Exit codes match the macOS helper: 0 ok, 1 failed, 2 cancelled, 3 unavailable.
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]',
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])',
  "if ($avail -ne 'Available') { Write-Output \"unavailable: Windows Hello $avail\"; exit 3 }",
  "if ($env:PASEBOON_AUTH_MODE -eq 'check') { Write-Output 'available'; exit 0 }",
  `$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${AUTH_REASON}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])`,
  "switch ($r) { 'Verified' { exit 0 } 'Canceled' { exit 2 } 'RetriesExhausted' { exit 1 } default { Write-Output \"unavailable: $r\"; exit 3 } }",
].join('\n');

function run(execFile, file, args, { timeout, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout, missing: false });
      if (err.code === 'ENOENT') return resolve({ code: null, stdout: '', missing: true });
      // timeout/killed -> signal set, code null -> denied by mapExitCode
      resolve({ code: typeof err.code === 'number' ? err.code : null, stdout: String(stdout || ''), missing: false });
    });
  });
}

/**
 * @returns {{ name: string, authenticate: () => Promise<{result, detail?}>, check: () => Promise<{available, detail}> }}
 */
export function createAuthenticator({ platform = process.platform, helper, execFile = nodeExecFile, exists = existsSync } = {}) {
  if (platform === 'darwin') {
    const missing = () => ({ result: Result.UNAVAILABLE, detail: `authentication helper missing (${helper})` });
    return {
      name: 'macos-localauthentication',
      async authenticate() {
        if (!helper || !exists(helper)) return missing();
        const r = await run(execFile, helper, [AUTH_REASON], { timeout: PROMPT_TIMEOUT_MS });
        if (r.missing) return missing();
        const result = mapExitCode(r.code);
        return { result, detail: result === Result.UNAVAILABLE ? r.stdout.trim() || 'no Touch ID or password set' : undefined };
      },
      async check() {
        if (!helper || !exists(helper)) return { available: false, detail: missing().detail };
        const r = await run(execFile, helper, ['--check'], { timeout: CHECK_TIMEOUT_MS });
        return { available: r.code === 0, detail: r.stdout.trim() || `exit ${r.code}` };
      },
    };
  }
  if (platform === 'win32') {
    const ps = 'powershell.exe';
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT];
    return {
      name: 'windows-hello',
      async authenticate() {
        const r = await run(execFile, ps, args, {
          timeout: PROMPT_TIMEOUT_MS, env: { ...process.env, PASEBOON_AUTH_MODE: 'prompt' },
        });
        if (r.missing) return { result: Result.UNAVAILABLE, detail: 'PowerShell not found' };
        const result = mapExitCode(r.code);
        return { result, detail: result === Result.UNAVAILABLE ? r.stdout.trim() : undefined };
      },
      async check() {
        const r = await run(execFile, ps, args, {
          timeout: CHECK_TIMEOUT_MS, env: { ...process.env, PASEBOON_AUTH_MODE: 'check' },
        });
        return { available: r.code === 0, detail: r.stdout.trim() || `exit ${r.code}` };
      },
    };
  }
  if (platform === 'linux') {
    return {
      name: 'linux-polkit',
      async authenticate() {
        const r = await run(execFile, 'pkexec', ['/bin/true'], { timeout: PROMPT_TIMEOUT_MS });
        if (r.missing) return { result: Result.UNAVAILABLE, detail: 'pkexec (polkit) not installed' };
        // pkexec: 0 ok, 126 dialog dismissed, 127 not authorized / auth failed / error
        if (r.code === 0) return { result: Result.OK };
        if (r.code === 127) return { result: Result.FAILED };
        return { result: Result.CANCELLED };
      },
      async check() {
        const r = await run(execFile, 'pkexec', ['--version'], { timeout: CHECK_TIMEOUT_MS });
        return { available: !r.missing && r.code === 0, detail: r.missing ? 'pkexec not installed' : r.stdout.trim() };
      },
    };
  }
  return {
    name: 'none',
    async authenticate() { return { result: Result.UNAVAILABLE, detail: `no OS authentication on ${platform}` }; },
    async check() { return { available: false, detail: `unsupported platform ${platform}` }; },
  };
}
