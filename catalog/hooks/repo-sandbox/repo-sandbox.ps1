# PreToolUse hook: block tool calls that touch paths outside this repo.
# Self-resolving: repo root is derived from this script's own location.

$ErrorActionPreference = 'Stop'

try {
    $REPO = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} catch {
    exit 0  # fail open if root can't be resolved
}
$repoFull = $REPO.ToLowerInvariant().TrimEnd('\').TrimEnd('/')

# Read the hook payload from stdin
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
try { $payload = $raw | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }

$tool = [string]$payload.tool_name
$inp  = $payload.tool_input

function Resolve-Norm {
    param([string]$p)
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $p = $p.Trim().Trim('"').Trim("'")
    # MSYS / git-bash form: //c/foo  ->  c:/foo
    if ($p -match '^//([a-zA-Z])/(.*)$') { $p = "$($Matches[1]):/$($Matches[2])" }
    # Relative path -> resolve against repo (intentionally lenient)
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $REPO $p }
    try { return [IO.Path]::GetFullPath($p) } catch { return $null }
}

function Is-Inside-Repo {
    param([string]$full)
    if ([string]::IsNullOrEmpty($full)) { return $true }
    $f = $full.ToLowerInvariant()
    return ($f -eq $repoFull) -or $f.StartsWith($repoFull + '\') -or $f.StartsWith($repoFull + '/')
}

$bad = New-Object System.Collections.Generic.List[string]

switch -Regex ($tool) {
    '^(Read|Edit|Write|NotebookEdit|MultiEdit)$' {
        $candidates = @($inp.file_path, $inp.notebook_path, $inp.path)
        foreach ($c in $candidates) {
            $r = Resolve-Norm $c
            if ($r -and -not (Is-Inside-Repo $r)) { [void]$bad.Add($r) }
        }
    }
    '^(Bash|PowerShell)$' {
        $cmd = [string]$inp.command
        if ($cmd) {
            # Windows drive-letter paths: c:\foo, C:/foo  (stop at whitespace and shell metachars)
            $rxWin   = [regex]'([a-zA-Z]):[\\/][^\s''"`|;&<>()]*'
            # MSYS-style: //c/foo
            $rxMsys  = [regex]'//([a-zA-Z])/[^\s''"`|;&<>()]*'
            foreach ($rx in @($rxWin, $rxMsys)) {
                foreach ($m in $rx.Matches($cmd)) {
                    $r = Resolve-Norm $m.Value
                    if ($r -and -not (Is-Inside-Repo $r)) { [void]$bad.Add($r) }
                }
            }
        }
    }
}

if ($bad.Count -gt 0) {
    $list = ($bad | Select-Object -Unique) -join "`n  "
    [Console]::Error.WriteLine("repo-sandbox: blocked — path(s) outside $REPO`:`n  $list`n(If this is intentional, edit .claude/hooks/repo-sandbox.ps1 or bypass via user approval.)")
    exit 2
}
exit 0
