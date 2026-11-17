[CmdletBinding()]
param([switch]$CheckOnly, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$package = Get-AppxPackage -Name 'AnthropicPBC.Claude' | Select-Object -First 1
if (!$package) { throw 'Claude Microsoft Store app is not installed for this user.' }
$appId = "$($package.PackageFamilyName)!Claude"

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
        if (Test-Path -LiteralPath (Join-Path $dir 'cc-switch.exe')) {
            return $dir
        }
    }
    throw 'CC Switch directory not found (cc-switch.exe missing). Set $env:CCSWITCH_DIR or install CC Switch in a standard location.'
}

# 1. Check whether Claude is currently running in official 1p mode
$runningClaude = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue
$deploymentConfigPath = Join-Path $env:LOCALAPPDATA 'Claude\claude_desktop_config.json'
$currentMode = '1p'
if (Test-Path -LiteralPath $deploymentConfigPath) {
    try {
        $cfg = Get-Content -LiteralPath $deploymentConfigPath -Raw | ConvertFrom-Json
        if ($cfg.deploymentMode) { $currentMode = $cfg.deploymentMode }
    } catch {}
}

if ($runningClaude -and $currentMode -eq '1p') {
    if ($CheckOnly) {
        [pscustomobject]@{ status = 'running_in_other_mode'; currentMode = $currentMode; action = 'safe_blocked' }
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "检测到 Claude 当前正在以【官方模式】运行中。`n`n为了保护您的任务和配置隔离，请先正常关闭当前运行的 Claude 窗口，然后再点击此图标启动 Vertex 镜像版。",
        "Claude 模式切换提示",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    exit 0
}

if ($CheckOnly) {
    [pscustomobject]@{
        appId                  = $appId
        packageVersion         = $package.Version.ToString()
        startsGateway          = $true
        startsCCSwitch         = $true
        changesAccountOrModels = $false
        launchesApp            = $false
    }
    return
}

# 2. Switch deployment mode to 3p mirror
$claudeConfigDir = Join-Path $env:LOCALAPPDATA 'Claude'
if (!(Test-Path -LiteralPath $claudeConfigDir)) { New-Item -ItemType Directory -Path $claudeConfigDir -Force | Out-Null }
@{ deploymentMode = '3p' } | ConvertTo-Json | Set-Content -LiteralPath $deploymentConfigPath -Encoding utf8

# 3. Start local CLIProxyAPI gateway (18432) and CC Switch (15721)
& (Join-Path $root 'start-gateways.ps1') | Out-Null
$switchDir = Resolve-CCSwitchDir
$switchPath = Join-Path $switchDir 'cc-switch.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='cc-switch.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $switchPath })
if (!$running) {
    Start-Process -FilePath $switchPath -WorkingDirectory $switchDir
}

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 15721 -State Listen -ErrorAction SilentlyContinue) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 250
}
if (!$ready) { throw 'CC Switch port 15721 is not ready.' }

& (Join-Path $root 'sync-desktop-model-capabilities.ps1') | Out-Null

if ($PrepareOnly) {
    [pscustomobject]@{ ready = $true; appId = $appId; appLaunched = $false }
    return
}

# 4. Launch Microsoft Store Claude app
Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId" -WindowStyle Hidden
