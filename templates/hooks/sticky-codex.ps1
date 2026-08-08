# sticky-codex.ps1 - Codex wrapper for Sticky Note V3 (Windows)
#
# Captures Codex stdout/stderr to a temp session log.
# On exit: calls session-end.js with the transcript for
# narrative + failed_approaches extraction.
#
# V3: If STICKY_URL is set, reads cloud context before session start
# and writes session data to cloud on exit (via hook scripts).
#
# Usage:
#   .\sticky-codex.ps1 [codex args...]
#
# Setup:
#   npx sticky-note init --codex

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StickyDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) ".sticky-note"
$SessionId = "codex-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"
$TranscriptFile = [System.IO.Path]::GetTempFileName()
$User = if ($env:USER) { $env:USER } elseif ($env:USERNAME) { $env:USERNAME } else { "unknown" }

if (-not (Test-Path $StickyDir)) {
    New-Item -ItemType Directory -Path $StickyDir -Force | Out-Null
}

Write-Host ""
Write-Host "[STICKY-NOTE] Injecting context for Codex session $SessionId"
Write-Host ""

# Load .env.sticky if it exists (for STICKY_URL and STICKY_API_KEY)
$EnvStickyFile = Join-Path (Split-Path -Parent (Split-Path -Parent $ScriptDir)) ".env.sticky"
if (Test-Path $EnvStickyFile) {
    Get-Content $EnvStickyFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $eq = $line.IndexOf("=")
            if ($eq -gt 0) {
                $key = $line.Substring(0, $eq).Trim()
                $val = $line.Substring($eq + 1).Trim()
                [Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
}

$MemoryFile = Join-Path $StickyDir "sticky-note.json"
if (Test-Path $MemoryFile) {
    try {
        $inputJson = @{ session_id = $SessionId } | ConvertTo-Json -Compress
        $inputJson | & node "$ScriptDir\session-start.js" 2>$null
    } catch {
        # ignore
    }
}

Write-Host "---------------------------------------------"
Write-Host ""

# Run Codex, capturing output
$CodexExit = 0
try {
    & codex @CodexArgs 2>&1 | Tee-Object -FilePath $TranscriptFile
    $CodexExit = $LASTEXITCODE
} catch {
    $CodexExit = 1
}

Write-Host ""
Write-Host "---------------------------------------------"
Write-Host "[STICKY-NOTE] Processing Codex session..."

# Parse transcript for narrative + failed_approaches
$Parsed = '{"narrative":"","failed_approaches":[]}'
try {
    $Parsed = & node "$ScriptDir\parse-transcript.js" $TranscriptFile 2>$null
    if (-not $Parsed) {
        $Parsed = '{"narrative":"","failed_approaches":[]}'
    }
} catch {
    # ignore
}

# Call session-end.js with the transcript info + parsed data
try {
    $endInput = @"
{
    "session_id": "$SessionId",
    "transcript_path": "$($TranscriptFile -replace '\\', '\\')",
    "parsed_transcript": $Parsed,
    "hook_event_name": "sessionEnd",
    "reason": "codex_exit"
}
"@
    $endInput | & node "$ScriptDir\session-end.js" 2>$null
} catch {
    # ignore
}

# Cleanup transcript
if (Test-Path $TranscriptFile) {
    Remove-Item -Path $TranscriptFile -Force -ErrorAction SilentlyContinue
}

Write-Host "[OK] Session $SessionId recorded."
Write-Host ""

exit $CodexExit
