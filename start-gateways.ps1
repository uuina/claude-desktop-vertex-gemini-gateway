$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$configPath = Join-Path $taskRoot 'guard-config.json'
if (!(Test-Path -LiteralPath $configPath)) { throw "Configuration file not found: $configPath (copy guard-config.example.json first)." }
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$expectedModels = if ($settings.allowedModels) { @($settings.allowedModels) } else { @($settings.model) }
$expectedBackendModels = $expectedModels

$modelAccessEnabled = $true
if ($null -ne $settings.PSObject.Properties['billingCreditPolicyAccepted'] -or $null -ne $settings.PSObject.Properties['cutoffUtc']) {
    $cutoffParsed = [DateTimeOffset]::MinValue
    $hasCutoff = $settings.cutoffUtc -and [DateTimeOffset]::TryParse([string]$settings.cutoffUtc, [ref]$cutoffParsed)
    $modelAccessEnabled = ($settings.billingCreditPolicyAccepted -eq $true) -and $hasCutoff -and ([DateTimeOffset]::UtcNow -lt $cutoffParsed)
}

$gatewayExe = Join-Path $taskRoot 'gateway-8.0.66\cli-proxy-api.exe'
$gatewayConfig = Join-Path $taskRoot 'private\gateway.yaml'
if (!(Test-Path -LiteralPath $gatewayExe)) { throw 'Verified CLIProxyAPI binary is not installed yet.' }
if (!(Test-Path -LiteralPath $gatewayConfig)) { throw 'Gateway configuration is not ready.' }

$gatewayConfigText = Get-Content -LiteralPath $gatewayConfig -Raw
$limitMatch = [regex]::Match($gatewayConfigText, '"generationConfig\.maxOutputTokens":\s*(\d+)')
if (!$limitMatch.Success -or [int]$limitMatch.Groups[1].Value -ne $settings.maxOutputTokens) {
    throw 'Native Vertex output cap and budget reservation limit must match.'
}
foreach ($model in $expectedModels) {
    if (!$gatewayConfigText.Contains(('name: "' + $model + '"'))) {
        throw 'A protected model is missing its native payload policy.'
    }
}

$secretsRelPath = if ($settings.secretsPath) { [string]$settings.secretsPath } else { 'private\keys.json' }
$secretsFullPath = if ([System.IO.Path]::IsPathRooted($secretsRelPath)) { $secretsRelPath } else { Join-Path $taskRoot $secretsRelPath }
if (!(Test-Path -LiteralPath $secretsFullPath)) { throw "Secrets file not found: $secretsFullPath" }
$keys = Get-Content -LiteralPath $secretsFullPath -Raw | ConvertFrom-Json

$logRoot = Join-Path $taskRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$backendUrl = ([string]$settings.backendUrl).TrimEnd('/')
$backendReady = $false

if ($modelAccessEnabled) {
    try {
        $models = Invoke-RestMethod -Uri ($backendUrl + '/v1/models') -Headers @{ Authorization = ('Bearer ' + $keys.backendKey) } -TimeoutSec 2
        $backendReady = @($expectedBackendModels | Where-Object { $_ -notin $models.data.id }).Count -eq 0
    } catch {}

    if (!$backendReady) {
        if (Get-NetTCPConnection -State Listen -LocalPort 18432 -ErrorAction SilentlyContinue) {
            throw 'Port 18432 is in use by a different or unready service.'
        }
        $backend = Start-Process -FilePath $gatewayExe -ArgumentList @('-config', $gatewayConfig, '-local-model') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'gateway.stdout.log') -RedirectStandardError (Join-Path $logRoot 'gateway.stderr.log')
        $backend.Id | Set-Content -LiteralPath (Join-Path $logRoot 'gateway.pid')
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 500
            try {
                $models = Invoke-RestMethod -Uri ($backendUrl + '/v1/models') -Headers @{ Authorization = ('Bearer ' + $keys.backendKey) } -TimeoutSec 2
                if (@($expectedBackendModels | Where-Object { $_ -notin $models.data.id }).Count -eq 0) {
                    $backendReady = $true
                    break
                }
            } catch {}
            if ($backend.HasExited) { throw 'Gateway exited. See local gateway logs.' }
        }
        if (!$backendReady) { throw 'Gateway did not advertise all protected Gemini models.' }
    }
}

Write-Output 'CLIProxyAPI is ready on 127.0.0.1:18432 (direct connection to CC Switch)'
