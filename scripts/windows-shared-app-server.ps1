param(
    [ValidateSet("start", "status", "stop", "restart")]
    [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Windows shared app-server management is supported only on native Windows."
}
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    throw "Bun 1.3+ is required and was not found on PATH."
}

$entryPoint = Join-Path $PSScriptRoot "app-server-lifecycle.ts"
& $bun.Source $entryPoint $Command
exit $LASTEXITCODE
