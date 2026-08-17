$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Codex Web supports this launcher only on native Windows."
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun 1.3+ is required and was not found on PATH."
}
if ($env:CODEX_WEB_CODEX_EXECUTABLE) {
    if ($env:CODEX_WEB_CODEX_EXECUTABLE -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') {
        throw "CODEX_WEB_CODEX_EXECUTABLE must be an absolute path."
    }
    if (-not (Test-Path -LiteralPath $env:CODEX_WEB_CODEX_EXECUTABLE -PathType Leaf)) {
        throw "Configured Codex executable does not exist: $env:CODEX_WEB_CODEX_EXECUTABLE"
    }
    $codexExecutable = $env:CODEX_WEB_CODEX_EXECUTABLE
} else {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if (-not $codexCommand) {
        throw "Codex is required and was not found on PATH."
    }
    $codexExecutable = $codexCommand.Source
}

Write-Host "Using Bun $(bun --version)"
Write-Host "Using $(& $codexExecutable --version)"
Set-Location (Join-Path $PSScriptRoot "..")
bun run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
bun run start
exit $LASTEXITCODE
