$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$sdkVersion = '1.0.3650.58'
$packages = Join-Path $nativeRoot 'packages'
$sdk = Join-Path $packages "webview2-$sdkVersion"
$output = Join-Path $nativeRoot 'bin'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }

if (-not (Test-Path -LiteralPath (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'))) {
    New-Item -ItemType Directory -Force -Path $packages | Out-Null
    $archive = Join-Path $packages "webview2-$sdkVersion.zip"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $archive -TimeoutSec 30
    Expand-Archive -LiteralPath $archive -DestinationPath $sdk -Force
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', 'System.Security.dll', (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'))
$compilerArgs = @('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', ('/out:' + (Join-Path $output 'CalendarWebView.exe')))
foreach ($reference in $references) { $compilerArgs += '/reference:' + $reference }
$compilerArgs += Join-Path $nativeRoot 'CalendarHost.cs'
& $compiler $compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'The WebView host could not be compiled.' }
Copy-Item -LiteralPath (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll') -Destination $output
Copy-Item -LiteralPath (Join-Path $nativeRoot 'CalendarWebView.exe.config') -Destination $output
# The managed SDK resolves the loader from the process architecture subfolder.
foreach ($architecture in @('x86', 'x64', 'arm64')) {
    $loaderOutput = Join-Path $output $architecture
    New-Item -ItemType Directory -Force -Path $loaderOutput | Out-Null
    Copy-Item -LiteralPath (Join-Path $sdk "runtimes\win-$architecture\native\WebView2Loader.dll") -Destination $loaderOutput
}
Write-Output 'Built the Windows system WebView host.'
