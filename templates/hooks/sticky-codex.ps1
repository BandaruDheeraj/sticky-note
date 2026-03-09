# sticky-codex.ps1 - Codex wrapper for Sticky Note V2 (Windows)
#
# Captures Codex stdout/stderr to a temp session log.
# On exit: calls session-end.js with the transcript for
# narrative + failed_approaches extraction.
#
# Usage:
#   .\sticky-codex.ps1 [codex args...]
#
# Setup:
#   npx sticky-note init --codex
#
# Limitation: Context is printed to terminal after Codex exits,
# not injected into the Codex window. Per-prompt surfacing not available.

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
