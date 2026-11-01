$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tools=Join-Path $projectRoot 'runtime-tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$archive=Join-Path $tools 'uv-0.13.6.zip'
$digest='a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
if(-not (Test-Path -LiteralPath $archive)){
  Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $digest){throw 'uv archive checksum mismatch'}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $tools 'uv') -Force
$uv=(Get-ChildItem -LiteralPath (Join-Path $tools 'uv') -Filter uv.exe -Recurse | Select-Object -First 1).FullName
$names=@('UV_CACHE_DIR','UV_PYTHON_INSTALL_DIR','SOURCE_SCRAPER_X_ACCOUNT_SESSION','SOURCE_SCRAPER_X_CSRF','SOURCE_SCRAPER_GETXAPI_API_KEY')
$prior=@{};foreach($name in $names){$prior[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
  foreach($name in @('SOURCE_SCRAPER_X_ACCOUNT_SESSION','SOURCE_SCRAPER_X_CSRF','SOURCE_SCRAPER_GETXAPI_API_KEY')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
  $env:UV_CACHE_DIR=Join-Path $tools 'cache'
  $env:UV_PYTHON_INSTALL_DIR=Join-Path $tools 'python'
  $venv=Join-Path $tools 'x-local'
  $python=Join-Path $venv 'Scripts\python.exe'
  if(-not (Test-Path -LiteralPath $python)){
    & $uv venv $venv --python 3.12 --managed-python
    if($LASTEXITCODE){throw 'Project-local Python setup failed'}
  }
  & $uv pip install --python $python --requirement (Join-Path $PSScriptRoot 'requirements-x-local.txt')
  if($LASTEXITCODE){throw 'Pinned local X dependencies failed to install'}
  & $python -I -c 'import twikit; assert twikit.__version__ == "2.4.0"; print("Twifork 2.4.0 ready; no account request made")'
  if($LASTEXITCODE){throw 'Twifork import check failed'}
  [pscustomobject]@{python=$python;twifork='2.4.0';uv='0.13.6'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tools 'x-local-runtime.json') -Encoding utf8
  Write-Output "Local X Python: $python"
}finally{foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$prior[$name],'Process')}}
