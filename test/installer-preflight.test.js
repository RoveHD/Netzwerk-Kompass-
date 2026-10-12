import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('installer smoke accepts a missing registry key without hiding existing installs or read errors', { skip: process.platform !== 'win32' }, async () => {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/smoke-installer.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw $parseErrors[0] }
    $uninstallRoot = 'fixture-registry'
    function Test-Path { param($LiteralPath) if ($script:denied) { throw 'Registry access denied' }; $script:exists }
    function Get-ChildItem {
      param($LiteralPath)
      if (-not $script:exists) { throw 'Missing registry must not be enumerated' }
      [pscustomobject]@{ DisplayName = 'Other app' }
      [pscustomobject]@{ DisplayName = 'Netzwerk-Kompass'; DisplayVersion = '1.1.0' }
    }
    function Get-ItemProperty { param([Parameter(ValueFromPipeline)]$InputObject) process { $InputObject } }
    foreach ($variable in @('$existing', '$remaining')) {
      $assignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq $variable }, $true)
      if (-not $assignment) { throw "Missing registry query: $variable" }
      $query = [scriptblock]::Create($assignment.Right.Extent.Text)
      $script:denied = $false; $script:exists = $false
      if (@(& $query).Count -ne 0) { throw 'Missing registry is not empty' }
      $script:exists = $true
      $found = @(& $query)
      if ($found.Count -ne 1 -or $found[0].DisplayName -ne 'Netzwerk-Kompass') { throw 'Existing installation was not preserved' }
      $script:denied = $true
      $failure = $null
      try { & $query } catch { $failure = $_ }
      if (-not $failure -or $failure.ToString() -notlike '*Registry access denied*') { throw 'Registry access error was hidden' }
    }
    Write-Output 'registry checks passed'
  `;
  const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 30_000
  });
  assert.equal(stdout.trim(), 'registry checks passed');
});
