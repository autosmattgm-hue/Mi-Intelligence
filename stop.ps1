# MI — stop the trading server on Windows
$ErrorActionPreference = 'SilentlyContinue'
Set-Location 'f:\Mi Trading'

if (Test-Path '.server.pid') {
  $pidFile = Get-Content '.server.pid'
  if ($pidFile) {
    Stop-Process -Id $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped server PID $pidFile."
  }
}
# Fallback: kill any node running this project
Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Remove-Item '.server.pid' -Force -ErrorAction SilentlyContinue
Write-Host 'MI server stopped.'