import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Invoke-Native decodes UTF-8, BOM and OEM bytes on both process streams', async () => {
  if (process.platform !== 'win32') return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temporary = await mkdtemp(path.join(tmpdir(), 'native-encoding-'));
  const child = path.join(temporary, 'native-output.ps1');
  const harness = path.join(temporary, 'harness.ps1');
  const childText = String.raw`
$ErrorActionPreference = 'Stop'
$text = 'WLAN f' + [char]0x00FC + 'r Ger' + [char]0x00E4 + 'te ben' + [char]0x00F6 + 'tigen ' + [char]0x2026
$errorText = 'Fehler f' + [char]0x00FC + 'r ' + [char]0x00C4 + [char]0x00D6 + [char]0x00DC
$out = [System.Text.Encoding]::UTF8.GetBytes($text)
$err = [System.Text.Encoding]::UTF8.GetPreamble() + [System.Text.Encoding]::UTF8.GetBytes($errorText)
$stdout = [Console]::OpenStandardOutput()
foreach ($b in $out) { $stdout.WriteByte($b) }
$stderr = [Console]::OpenStandardError()
foreach ($b in $err) { $stderr.WriteByte($b) }
exit 7
`;
  const functionNames = ['Convert-NativeBytes', 'Invoke-Native'];
  const harnessText = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = ${"'"}${path.join(root, 'scripts', 'probe.ps1').replaceAll("'", "''")}${"'"}
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
foreach ($name in @(${functionNames.map(n => `'${n}'`).join(',')})) {
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if ($null -eq $function) { throw "Missing function $name" }
  Invoke-Expression $function.Extent.Text | Out-Null
}
$oemEncoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
$utf8Text = 'WLAN f' + [char]0x00FC + 'r Ger' + [char]0x00E4 + 'te ben' + [char]0x00F6 + 'tigen ' + [char]0x2026
$bomText = 'Fehler f' + [char]0x00FC + 'r ' + [char]0x00C4 + [char]0x00D6 + [char]0x00DC
$legacyText = $bomText
$unit = @{
  utf8 = Convert-NativeBytes ([System.Text.Encoding]::UTF8.GetBytes($utf8Text))
  bom = Convert-NativeBytes ([System.Text.Encoding]::UTF8.GetPreamble() + [System.Text.Encoding]::UTF8.GetBytes($bomText))
  utf16le = Convert-NativeBytes ([System.Text.Encoding]::Unicode.GetPreamble() + [System.Text.Encoding]::Unicode.GetBytes($utf8Text))
  utf16be = Convert-NativeBytes ([System.Text.Encoding]::BigEndianUnicode.GetPreamble() + [System.Text.Encoding]::BigEndianUnicode.GetBytes($utf8Text))
  oem = Convert-NativeBytes ($oemEncoding.GetBytes($legacyText))
  chunkBoundary = Convert-NativeBytes ([System.Text.Encoding]::UTF8.GetBytes('f') + [System.Text.Encoding]::UTF8.GetBytes(([char]0x00FC).ToString() + 'r ' + [char]0x2026))
  empty = Convert-NativeBytes ([byte[]]@())
}
$native = Invoke-Native 'powershell.exe' ('-NoProfile -File "${child}"') 10000
$emptyNative = Invoke-Native 'powershell.exe' '-NoProfile -Command exit' 10000
ConvertTo-Json -InputObject @{ unit = $unit; native = $native; emptyNative = $emptyNative } -Compress
`;
  try {
    await writeFile(child, childText, 'utf8');
    await writeFile(harness, harnessText, 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    const data = parsed;
    assert.ok(data.native && !Array.isArray(data.native), JSON.stringify(data));
    assert.ok(data.emptyNative && !Array.isArray(data.emptyNative), JSON.stringify(data));
    assert.equal(data.unit.utf8, 'WLAN für Geräte benötigen …');
    assert.equal(data.unit.bom, 'Fehler für ÄÖÜ');
    assert.equal(data.unit.utf16le, 'WLAN für Geräte benötigen …');
    assert.equal(data.unit.utf16be, 'WLAN für Geräte benötigen …');
    assert.equal(data.unit.oem, 'Fehler für ÄÖÜ');
    assert.equal(data.unit.chunkBoundary, 'für …');
    assert.equal(data.unit.empty, '');
    assert.equal(data.native.output, 'WLAN für Geräte benötigen …');
    assert.equal(data.native.error, 'Fehler für ÄÖÜ');
    assert.equal(data.native.code, 7);
    assert.equal(data.emptyNative.output, '');
    assert.equal(data.emptyNative.error, '');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
