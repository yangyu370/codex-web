$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "The Codex Web shared CLI wrapper is supported only on native Windows."
}
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    throw "Bun 1.3+ is required and was not found on PATH."
}
if ($env:CODEX_WEB_WINDOWS_SHARED -eq "off") {
    throw "Windows shared mode is disabled by CODEX_WEB_WINDOWS_SHARED=off."
}

$codexArguments = @($args)
foreach ($argument in $codexArguments) {
    if (
        $argument -eq "--remote" -or
        $argument -like "--remote=*" -or
        $argument -eq "--remote-auth-token-env" -or
        $argument -like "--remote-auth-token-env=*"
    ) {
        throw "CLI arguments must not replace the managed remote endpoint."
    }
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

$entryPoint = Join-Path $PSScriptRoot "app-server-lifecycle.ts"
$lifecycleOutput = & $bun.Source $entryPoint start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
try {
    $connection = $lifecycleOutput | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw "Shared app-server lifecycle returned invalid JSON."
}
if (-not $connection.endpoint) {
    throw "Shared app-server lifecycle returned no endpoint."
}

& $codexExecutable --remote $connection.endpoint @codexArguments
exit $LASTEXITCODE
