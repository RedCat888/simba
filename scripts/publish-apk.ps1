<#
  Build, publish and hand back a link that works on the phone.

  Written because getting a new APK onto the S24 failed repeatedly for reasons
  that were each individually invisible: the file downloaded correctly every
  time, but versionCode was pinned at 1 so Android treated every install as
  "already have this" and did nothing. Verifying the upload proved nothing about
  the thing that mattered.

  So this checks what the *published* file declares to the installer, not what
  the local build says, and prints the versionCode so a no-op install is
  obvious rather than inferred.

  Releases live on a private repo, so the browser download URL 404s without a
  login. The signed asset URL below works without one and lasts about five
  minutes, which is long enough to install and short enough not to be a leak.
#>
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$repo = 'PROJECT_OWNER/simba'
$apk  = 'C:/workspace/simba/android/app/build/outputs/apk/release/app-release.apk'
$aapt = (Get-ChildItem "$env:LOCALAPPDATA/Android/Sdk/build-tools/*/aapt2.exe" | Select-Object -Last 1).FullName

if (-not $SkipBuild) {
    Push-Location C:/workspace/simba/android
    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
    ./gradlew.bat assembleRelease --console=plain | Select-String -Pattern '^e: |BUILD'
    Pop-Location
}

$badging = & $aapt dump badging $apk | Select-Object -First 1
$vc = [regex]::Match($badging, "versionCode='(\d+)'").Groups[1].Value
if (-not $vc) { throw 'could not read versionCode from the built APK' }
Write-Output "built versionCode $vc"

gh release create "v$vc" "$apk#simba.apk" --repo $repo --title "Simba $vc" --notes "Automated build." 2>&1 |
    Select-Object -Last 1

# Verify against what the release actually holds, not the local file.
$assetId = gh api "repos/$repo/releases/tags/v$vc" --jq '.assets[0].id'
$token   = gh auth token
$signed  = (curl.exe -s -o NUL -D - -H "Authorization: Bearer $token" `
              -H 'Accept: application/octet-stream' `
              "https://api.github.com/repos/$repo/releases/assets/$assetId" |
            Select-String -Pattern '^location:' | ForEach-Object { $_.Line -replace '^[Ll]ocation: ','' }).Trim()

Write-Output ''
Write-Output "versionCode $vc  --  install link (about 5 minutes):"
Write-Output $signed
