[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name 'AnthropicPBC.Claude' | Select-Object -First 1
if (!$package) { throw 'Claude Microsoft Store app is not installed for this user.' }
$appId = "$($package.PackageFamilyName)!Claude"

# 1. Check whether Claude is currently running in 3p mode
$runningClaude = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue
$deploymentConfigPath = Join-Path $env:LOCALAPPDATA 'Claude\claude_desktop_config.json'
$currentMode = '1p'
if (Test-Path -LiteralPath $deploymentConfigPath) {
    try {
        $cfg = Get-Content -LiteralPath $deploymentConfigPath -Raw | ConvertFrom-Json
        if ($cfg.deploymentMode) { $currentMode = $cfg.deploymentMode }
    } catch {}
}

if ($runningClaude -and $currentMode -eq '3p') {
    if ($CheckOnly) {
        [pscustomobject]@{ status = 'running_in_other_mode'; currentMode = $currentMode; action = 'safe_blocked' }
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "检测到 Claude 当前正在以【Vertex 镜像模式】运行中。`n`n为了保护您的任务和配置隔离，请先正常关闭当前运行的 Claude 窗口，然后再点击此图标启动官方版。",
        "Claude 模式切换提示",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    exit 0
}

# 2. Pre-launch proxy connectivity guard (prevent direct unproxied connection)
$proxyReady = $false
$proxyPortListening = (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 7897 -State Listen -ErrorAction SilentlyContinue) -ne $null
if ($proxyPortListening) {
    try {
        $test = curl.exe -x http://127.0.0.1:7897 -I --max-time 3 --silent https://api.anthropic.com
        $statusLines = @($test -split "\r?\n" | Where-Object { $_ -match '^HTTP/(1\.1|2(\.0)?)\s+\d{3}' -and $_ -notmatch 'Connection established' })
        if ($statusLines -match '^HTTP/(1\.1|2(\.0)?)\s+(200|404|403|301|302|400)') {
            $proxyReady = $true
        }
    } catch {}
}

if ($CheckOnly) {
    [pscustomobject]@{
        appId              = $appId
        proxyPortListening = $proxyPortListening
        proxyReady         = $proxyReady
        targetMode         = '1p'
    }
    return
}

if (!$proxyReady) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "【安全拦截】检测到代理服务未就绪，或无法安全连通 Anthropic 官方服务器！`n`n为杜绝直连国内 IP 导致官方账号被封禁，已紧急阻止启动 Claude。`n`n请先确保 Clash / Mihomo 代理已开启并切换至正常境外节点后再试。",
        "Claude 官方防直连守卫",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    exit 1
}

# 3. Switch deployment mode to official 1p
$claudeConfigDir = Join-Path $env:LOCALAPPDATA 'Claude'
if (!(Test-Path -LiteralPath $claudeConfigDir)) { New-Item -ItemType Directory -Path $claudeConfigDir -Force | Out-Null }
@{ deploymentMode = '1p' } | ConvertTo-Json | Set-Content -LiteralPath $deploymentConfigPath -Encoding utf8

# 4. Launch official app
Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\$appId" -WindowStyle Hidden
