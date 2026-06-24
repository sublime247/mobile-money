param()

$ErrorActionPreference = 'Stop'

# Config
$gradleVersion = '9.2.0'
$distName = "gradle-$gradleVersion"
$zipName = "$distName-bin.zip"
$cacheRoot = Join-Path -Path $env:TEMP -ChildPath "mobile-money-build-cache"
$gradleCache = Join-Path -Path $cacheRoot -ChildPath "gradle"
$jdkCache = Join-Path -Path $cacheRoot -ChildPath "jdk"
$distDir = Join-Path -Path $gradleCache -ChildPath $distName
$zipPath = Join-Path -Path $gradleCache -ChildPath $zipName

function Get-JavaMajorVersion {
    try {
        $out = & java -version 2>&1
    } catch {
        return $null
    }
    if (-not $out) { return $null }
    # Example outputs: java version "1.8.0_341" or openjdk version "17.0.8" etc.
    foreach ($line in $out) {
        if ($line -match '"([0-9]+)(?:\.([0-9]+))?') {
            $a = [int]$Matches[1]
            if ($a -eq 1 -and $Matches[2]) { return [int]$Matches[2] }
            return $a
        }
    }
    return $null
}

function Ensure-JDK17 {
    $major = Get-JavaMajorVersion
    if ($major -ge 17) {
        Write-Host "Found Java major version $major - using system Java."
        return
    }

    Write-Host "No suitable Java (>=17) found - downloading portable Temurin JDK 17..."
    New-Item -ItemType Directory -Path $jdkCache -Force | Out-Null

    $apiUrl = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse'
    $jdkZip = Join-Path -Path $jdkCache -ChildPath 'temurin17.zip'

    if (-not (Test-Path $jdkZip)) {
        Invoke-WebRequest -Uri $apiUrl -OutFile $jdkZip -UseBasicParsing
    }

    Write-Host "Extracting JDK..."
    Expand-Archive -Path $jdkZip -DestinationPath $jdkCache -Force

    # Pick the most recently-created directory under the JDK cache (should be the extracted JDK)
    $jdkDir = Get-ChildItem -Path $jdkCache -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $jdkDir) {
        # Fallback: any directory under cache
        $jdkDir = Get-ChildItem -Path $jdkCache -Recurse -Directory | Select-Object -First 1
    }
    if (-not $jdkDir) { throw "Failed to locate extracted JDK in $jdkCache" }

    $javaHome = $jdkDir.FullName
    Write-Host "Using downloaded JDK at $javaHome"

    # Validate that the downloaded JDK provides a working java.exe
    $javaExe = Join-Path $javaHome 'bin\java.exe'
    if (-not (Test-Path $javaExe)) { throw "Downloaded JDK does not contain java executable: $javaExe" }
    $verOut = & $javaExe -version 2>&1 | Select-Object -First 1
    Write-Host "Downloaded JDK java -version: $verOut"

    # Set for this process
    $env:JAVA_HOME = $javaHome
    $env:Path = (Join-Path $javaHome 'bin') + ';' + $env:Path
}

function Ensure-Gradle {
    if (-not (Test-Path $distDir)) {
        Write-Host "Downloading Gradle $gradleVersion..."
        New-Item -ItemType Directory -Path $gradleCache -Force | Out-Null
        $url = "https://services.gradle.org/distributions/$zipName"
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
        Write-Host "Extracting $zipName..."
        Expand-Archive -Path $zipPath -DestinationPath $gradleCache -Force
    }
    $gradleBin = Join-Path -Path $distDir -ChildPath 'bin\gradle.bat'
    if (-not (Test-Path $gradleBin)) { throw "Gradle binary not found at $gradleBin" }
    return $gradleBin
}

# Ensure JDK 17 available (download if needed)
Ensure-JDK17

# Ensure Gradle is present
$gradleBin = Ensure-Gradle

Write-Host "Running Gradle build for sdk..."
& $gradleBin -p sdk build

if ($LASTEXITCODE -ne 0) { throw "Gradle build failed with exit code $LASTEXITCODE" }

Write-Host "Gradle build completed successfully."
