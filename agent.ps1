param(
  [Parameter(Mandatory=$true)][string]$Server,
  [Parameter(Mandatory=$true)][string]$Code
)

$ErrorActionPreference = "Stop"
$agentDir = Join-Path $env:LOCALAPPDATA "RelayCastAgent"
New-Item -ItemType Directory -Path $agentDir -Force | Out-Null

Write-Host "Downloading RelayCast OBS agent..." -ForegroundColor Cyan
Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/Rnrezanur/Stream-Command-Center/main/obs-agent.js" -OutFile (Join-Path $agentDir "obs-agent.js")

$env:RELAYCAST_URL = $Server.TrimEnd("/")
$env:RELAYCAST_PAIRING_CODE = $Code

Write-Host "Enter the OBS WebSocket password from OBS > Tools > WebSocket Server Settings." -ForegroundColor Yellow
$securePassword = Read-Host "OBS WebSocket password" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:OBS_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}

Write-Host "Connecting to OBS and RelayCast..." -ForegroundColor Green
Push-Location $agentDir
try {
  node ".\obs-agent.js"
} finally {
  Pop-Location
}
