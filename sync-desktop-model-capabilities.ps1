[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

function Resolve-CCSwitchDir {
    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($env:CCSWITCH_DIR)) {
        $candidates.Add($env:CCSWITCH_DIR.Trim())
    }
    $runningProc = Get-CimInstance Win32_Process -Filter "Name='cc-switch.exe'" -ErrorAction SilentlyContinue |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) } |
        Select-Object -First 1
    if ($runningProc) {
        $candidates.Add((Split-Path -Parent $runningProc.ExecutablePath))
    }
    foreach ($dir in @(
        'D:\Apps\CCSwitch',
        (Join-Path $env:LOCALAPPDATA 'Programs\CC Switch'),
        (Join-Path $env:LOCALAPPDATA 'Programs\CCSwitch'),
        (Join-Path $env:ProgramFiles 'CC Switch'),
        (Join-Path $env:ProgramFiles 'CCSwitch')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($dir)) {
            $candidates.Add($dir)
        }
    }
    foreach ($dir in ($candidates | Select-Object -Unique)) {
        if ((Test-Path -LiteralPath (Join-Path $dir 'data\live-state.json')) -or (Test-Path -LiteralPath (Join-Path $dir 'cc-switch.exe'))) {
            return $dir
        }
    }
    throw 'CC Switch directory not found. Set $env:CCSWITCH_DIR, start cc-switch.exe, or install CC Switch in a standard location.'
}

$ccSwitchDir = Resolve-CCSwitchDir
$livePath = Join-Path $ccSwitchDir 'data\live-state.json'
if (!(Test-Path -LiteralPath $livePath)) { return }

$live = Get-Content -LiteralPath $livePath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
if (-not $live -or -not $live.apps -or -not $live.apps.ContainsKey('claude-desktop')) { return }

$cdState = $live.apps['claude-desktop']
if ($cdState -is [System.Collections.IDictionary]) {
    if ($cdState.ContainsKey('mode') -and $cdState.mode -and $cdState.mode -ne 'proxy') { return }
    if ($cdState.ContainsKey('attached') -and $cdState.attached -eq $false) { return }
    if ($cdState.ContainsKey('proxy_route') -and [string]::IsNullOrWhiteSpace([string]$cdState.proxy_route)) { return }
    if ($cdState.contract -is [System.Collections.IDictionary] -and -not [string]::IsNullOrWhiteSpace([string]$cdState.contract.endpoint)) {
        if ($cdState.contract.endpoint -notmatch '^https?://(127\.0\.0\.1|localhost):(15721|18432)\b') { return }
    }
}

# If live-state.json exposes provider details, verify the active route targets local 15721/18432
if ($live.providers -is [System.Collections.IDictionary] -and $live.providers.ContainsKey('claude') -and $cdState.proxy_route) {
    $claudeProviders = $live.providers['claude']
    $matchedProvider = $null
    if ($claudeProviders -is [System.Collections.IDictionary] -and $claudeProviders.ContainsKey($cdState.proxy_route)) {
        $matchedProvider = $claudeProviders[$cdState.proxy_route]
    } elseif ($claudeProviders -is [System.Collections.IEnumerable]) {
        $matchedProvider = $claudeProviders | Where-Object { $_ -is [System.Collections.IDictionary] -and $_.id -eq $cdState.proxy_route } | Select-Object -First 1
    }
    if ($matchedProvider -is [System.Collections.IDictionary]) {
        $routeUrl = @($matchedProvider.base_url, $matchedProvider.baseUrl, $matchedProvider.url, $matchedProvider.endpoint) |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
            Select-Object -First 1
        if ($routeUrl -and ($routeUrl -notmatch '^https?://(127\.0\.0\.1|localhost):(15721|18432)\b')) {
            return
        }
    }
}

$configLibDir = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
if (!(Test-Path -LiteralPath $configLibDir)) { return }

$candidateFiles = [System.Collections.Generic.List[string]]::new()
$metaPath = Join-Path $configLibDir '_meta.json'
if (Test-Path -LiteralPath $metaPath) {
    try {
        $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        if ($meta -is [System.Collections.IDictionary] -and -not [string]::IsNullOrWhiteSpace([string]$meta.appliedId)) {
            $appliedPath = Join-Path $configLibDir ($meta.appliedId + '.json')
            if (Test-Path -LiteralPath $appliedPath) {
                $candidateFiles.Add($appliedPath)
            }
        }
    } catch {}
}

Get-ChildItem -LiteralPath $configLibDir -Filter '*.json' -File |
    Where-Object { $_.Name -ne '_meta.json' } |
    ForEach-Object {
        if (-not $candidateFiles.Contains($_.FullName)) {
            $candidateFiles.Add($_.FullName)
        }
    }

$targetProfilePath = $null
$targetProfile = $null
foreach ($filePath in $candidateFiles) {
    try {
        $candidate = Get-Content -LiteralPath $filePath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        if ($candidate -is [System.Collections.IDictionary] -and
            $candidate.inferenceProvider -eq 'gateway' -and
            ([string]$candidate.inferenceGatewayBaseUrl) -like 'http://127.0.0.1:15721*') {
            $targetProfilePath = $filePath
            $targetProfile = $candidate
            break
        }
    } catch {}
}

if (-not $targetProfile) { return }

$changed = 0
foreach ($entry in $targetProfile.inferenceModels) {
    if ($entry -is [System.Collections.IDictionary] -and $entry.labelOverride -match '^Gemini 4 (Argon|Carbon|Hydrogen)' -and $entry.maxEffort -ne 'high') {
        $entry.maxEffort = 'high'
        $changed++
    }
}

if ($changed -gt 0 -and !$CheckOnly) {
    $targetProfile | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $targetProfilePath -Encoding utf8
}

[pscustomobject]@{
    geminiEntriesUpdated = $changed
    maxEffort            = 'high'
    checkOnly            = [bool]$CheckOnly
}
