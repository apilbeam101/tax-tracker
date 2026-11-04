<#
.SYNOPSIS
UK Tax Tracker installer for Windows.

.DESCRIPTION
Checks for Node.js 24 or later (offering to install it when it is missing, never changing one that
is already there), installs the uk-tax-tracker package globally, creates the configuration with
`tax-tracker init`, and can start the app at logon and add a Start menu shortcut. A data folder
that this installer creates is restricted to your account. It never deletes your data; see
-Uninstall and -Purge.

To pass options, run it as:
  & ([scriptblock]::Create((irm <url>/install.ps1))) -Yes -NoShortcut
(Piping straight into iex works too, but cannot take options.)

.PARAMETER Version
Version to install (default: the version this script belongs to).
.PARAMETER Yes
Accept the default answer to every question.
.PARAMETER NoService
Do not start the app at logon.
.PARAMETER NoShortcut
Do not add a Start menu shortcut.
.PARAMETER Port
Port for the app (default 3000).
.PARAMETER DataDir
Where the database and config file live (default: per-user location).
.PARAMETER Prefix
npm global prefix to install into (default: npm's own).
.PARAMETER FromTarball
Install a packed tarball instead of the published package.
.PARAMETER Uninstall
Remove the scheduled task, shortcut and package; keeps your data.
.PARAMETER Purge
With -Uninstall: also delete the data folder, after a typed confirmation.
.PARAMETER TaskName
Name of the scheduled task (default: UK Tax Tracker).
.PARAMETER ShortcutDir
Folder for the shortcut (default: your Start menu Programs folder).
.PARAMETER AppDir
Folder for the launcher script, log and install record (default: %LOCALAPPDATA%\UkTaxTracker).
Pass the same value again to -Uninstall if you changed it.
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '', Justification = 'Read from the code below through the parent scope.')]
[CmdletBinding()]
param(
    [string]$Version = '__VERSION__',
    [switch]$Yes,
    [switch]$NoService,
    [switch]$NoShortcut,
    [int]$Port = 0,
    [string]$DataDir = '',
    [string]$Prefix = '',
    [string]$FromTarball = '',
    [switch]$Uninstall,
    [switch]$Purge,
    [string]$TaskName = '',
    [string]$ShortcutDir = '',
    [string]$AppDir = ''
)

# Everything runs inside this script block. Run through `iex` the script shares the caller's
# session, and without it the strict mode, error preference, variables and functions below would
# stay behind in the user's console.
& {
    param($ScriptCmdlet)

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $PackageName = 'uk-tax-tracker'
    $NodeMinMajor = 24
    $ConfirmPurgeWord = 'delete my data'
    $DefaultTaskName = 'UK Tax Tracker'

    function Resolve-UserPath {
        param([string]$Path)
        if ($Path -eq '') { return '' }
        if ($ScriptCmdlet) {
            $full = $ScriptCmdlet.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
        }
        else {
            $full = [IO.Path]::GetFullPath($Path)
        }
        $root = [IO.Path]::GetPathRoot($full)
        if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\') }
        return $full
    }

    # npm is run through its .cmd file, which cmd.exe parses, so these characters in a path would
    # be read as commands.
    function Assert-PathFitsCmd {
        param([string]$Path, [string]$Name)
        if ($Path -match '[&|<>^%"]') { throw "$Name must not contain any of & | < > ^ % `" : $Path" }
    }

    function Test-PathOverlap {
        param([string]$First, [string]$Second)
        $a = $First.TrimEnd('\') + '\'
        $b = $Second.TrimEnd('\') + '\'
        return $a.StartsWith($b, [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a, [StringComparison]::OrdinalIgnoreCase)
    }

    if ($Version -like '__*') { $Version = 'latest' }
    if ($Port -ne 0 -and ($Port -lt 1 -or $Port -gt 65535)) { throw '-Port must be a number between 1 and 65535' }
    if ($Purge -and -not $Uninstall) { throw '-Purge only goes with -Uninstall' }

    $DataDir = Resolve-UserPath $DataDir
    $Prefix = Resolve-UserPath $Prefix
    $FromTarball = Resolve-UserPath $FromTarball
    $ShortcutDir = Resolve-UserPath $ShortcutDir
    if ($AppDir -eq '') { $AppDir = Join-Path $env:LOCALAPPDATA 'UkTaxTracker' }
    $AppDir = Resolve-UserPath $AppDir
    if ($Prefix -ne '') { Assert-PathFitsCmd $Prefix '-Prefix' }
    if ($FromTarball -ne '') { Assert-PathFitsCmd $FromTarball '-FromTarball' }
    if ($DataDir -ne '' -and (Test-PathOverlap $AppDir $DataDir)) {
        throw "-AppDir ($AppDir) and -DataDir ($DataDir) must be separate folders, neither inside the other."
    }
    if ($ShortcutDir -eq '') { $ShortcutDir = [Environment]::GetFolderPath('Programs') }

    $AppPort = 3000
    if ($Port -ne 0) { $AppPort = $Port }
    $Url = "http://127.0.0.1:$AppPort"
    $Wrapper = Join-Path $AppDir 'run-server.ps1'
    $LogFile = Join-Path $AppDir 'tax-tracker.log'
    $StateFile = Join-Path $AppDir 'install-state.json'
    $ShortcutFile = Join-Path $ShortcutDir 'UK Tax Tracker.url'
    # The app is run from here, so a data folder inside whatever directory this script was started
    # from can never be picked up by accident.
    $NeutralDir = [Environment]::GetFolderPath('System')

    function Write-Say {
        param([string]$Message)
        Write-Information $Message -InformationAction Continue
    }

    function Test-CanPrompt {
        return (-not $Yes) -and [Environment]::UserInteractive -and (-not [Console]::IsInputRedirected)
    }

    # Succeeds for yes. -Yes and a session with no terminal both take the default.
    function Confirm-Step {
        param([string]$Question, [bool]$Default)
        if (-not (Test-CanPrompt)) { return $Default }
        if ($Default) { $hint = '[Y/n]' } else { $hint = '[y/N]' }
        $answer = Read-Host "$Question $hint"
        if ($answer -match '^[Yy]') { return $true }
        if ($answer -match '^[Nn]') { return $false }
        return $Default
    }

    function Get-RefreshedPath {
        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $user = [Environment]::GetEnvironmentVariable('Path', 'User')
        return "$machine;$user"
    }

    # Native commands write progress to stderr, which would stop the script under
    # $ErrorActionPreference = 'Stop' in Windows PowerShell 5.1. Their stderr goes to a file so it
    # is never mixed into the output that is read as a path or a number.
    function Invoke-Native {
        param([string]$File, [string[]]$Arguments)
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $errorFile = [IO.Path]::GetTempFileName()
        try {
            $output = & $File @Arguments 2>$errorFile | Out-String
            $code = $LASTEXITCODE
            if ($null -eq $code) { $code = 1 }
            $errorText = Get-Content -Raw -LiteralPath $errorFile -ErrorAction SilentlyContinue
        }
        catch {
            $output = ''
            $code = 1
            $errorText = $_.Exception.Message
        }
        finally {
            $ErrorActionPreference = $previous
            Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
        }
        if ($null -eq $output) { $output = '' }
        if ($null -eq $errorText) { $errorText = '' }
        return [pscustomobject]@{ ExitCode = $code; Output = ([string]$output).Trim(); Error = ([string]$errorText).Trim() }
    }

    function Get-Failure {
        param($Result)
        return (@($Result.Error, $Result.Output) | Where-Object { $_ -ne '' }) -join "`n"
    }

    # The .cmd file, never npm.ps1: under the default script policy of a Windows client a .ps1
    # cannot be loaded, and PowerShell prefers it to the .cmd.
    function Invoke-Npm {
        param([string[]]$Arguments)
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { throw 'npm was not found. It comes with Node.js; install Node.js 24 or later and run this again.' }
        return Invoke-Native $npm.Source $Arguments
    }

    function Get-NodeMajor {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) { return 0 }
        # No quotes inside the expression: Windows PowerShell 5.1 drops embedded double quotes
        # when it passes arguments to a native program.
        $result = Invoke-Native $node.Source @('-p', 'parseInt(process.versions.node)')
        if ($result.ExitCode -ne 0) { return 0 }
        return [int]$result.Output
    }

    function Install-NodeWithWinget {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "Node.js $NodeMinMajor or later is needed and winget is not available to install it. Install it from https://nodejs.org, then run this again."
        }
        Write-Say 'Installing Node.js (LTS) with winget...'
        $result = Invoke-Native 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-package-agreements', '--accept-source-agreements')
        if ($result.ExitCode -ne 0) { throw "winget could not install Node.js:`n$(Get-Failure $result)" }
        $env:Path = Get-RefreshedPath
    }

    function Confirm-Node {
        if (Get-Command node -ErrorAction SilentlyContinue) {
            $major = Get-NodeMajor
            if ($major -lt $NodeMinMajor) {
                throw "Node.js $(& node --version) is installed, but $NodeMinMajor or later is needed. This installer never changes an existing Node.js; upgrade it yourself and run this again."
            }
            return
        }
        if (-not $Yes -and -not (Test-CanPrompt)) {
            throw "Node.js $NodeMinMajor or later is needed. Run again with -Yes to let this installer install it."
        }
        if (-not (Confirm-Step "Node.js $NodeMinMajor or later was not found. Install it now?" $true)) { throw 'Node.js is required' }
        Install-NodeWithWinget
        if ((Get-NodeMajor) -lt $NodeMinMajor) {
            throw 'Node.js was installed but is not available yet; open a new PowerShell window and run this again.'
        }
    }

    function Get-NpmGlobalArgument {
        if ($Prefix -ne '') { return @('-g', '--prefix', $Prefix) }
        return @('-g')
    }

    function Get-PackageCli {
        $result = Invoke-Npm (@('root') + (Get-NpmGlobalArgument))
        if ($result.ExitCode -ne 0) { throw "npm could not report its global folder:`n$(Get-Failure $result)" }
        return Join-Path (Join-Path $result.Output $PackageName) 'dist\server\cli.js'
    }

    # Runs the installed command the way the scheduled task runs it: from a neutral directory,
    # with nothing in the caller's environment that changes where the data lives. Otherwise a data
    # folder in the current directory, or a DATA_DIR/DB_PATH in the session, would make init and
    # uninstall act on a different folder from the one the app uses.
    function Invoke-TaxTracker {
        param([string]$Cli, [string[]]$Arguments)
        $names = @('DB_PATH', 'DATA_DIR', 'AUTO_CONFIG', 'SESSION_SECRET', 'SESSION_SECRET_FILE')
        $saved = @{}
        foreach ($name in $names) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        Push-Location -LiteralPath $NeutralDir
        try {
            $node = (Get-Command node).Source
            return Invoke-Native $node (@($Cli) + $Arguments)
        }
        finally {
            Pop-Location
            foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
        }
    }

    function Get-DataDirFrom {
        param([string]$Text)
        foreach ($line in ($Text -split "`r?`n")) {
            if ($line -match '^Data directory:\s*(.+?)\s*\(from [^)]*\)\s*$') { return $Matches[1] }
        }
        return ''
    }

    function Read-InstallState {
        if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
        try { return Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } catch { return $null }
    }

    function Get-StateValue {
        param($State, [string]$Name)
        if ($null -eq $State) { return '' }
        $property = $State.PSObject.Properties[$Name]
        if ($null -eq $property -or $null -eq $property.Value) { return '' }
        return [string]$property.Value
    }

    function Write-InstallState {
        param([string]$Data)
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        $state = [ordered]@{ prefix = $Prefix; dataDir = $Data; taskName = $TaskName }
        Set-Content -LiteralPath $StateFile -Value ($state | ConvertTo-Json) -Encoding ASCII
    }

    function Protect-DataDir {
        param([string]$Path)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $result = Invoke-Native 'icacls' @($Path, '/inheritance:r', '/grant:r', "*${sid}:(OI)(CI)F")
        if ($result.ExitCode -ne 0) { Write-Warning "Could not restrict access to ${Path}:`n$(Get-Failure $result)" }
    }

    function ConvertTo-SingleQuoted {
        param([string]$Value)
        return "'" + [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Value) + "'"
    }

    # The task runs this small loop rather than node directly: a restore uploaded from the app makes
    # the app exit cleanly so that it is started again with the restored database, and a crash is
    # retried after a pause. The log is moved aside when it passes 5 MB.
    function Write-ServerWrapper {
        param([string]$Cli)
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        $nodeExe = (Invoke-Native (Get-Command node).Source @('-p', 'process.execPath')).Output
        $node = ConvertTo-SingleQuoted $nodeExe
        $cliQ = ConvertTo-SingleQuoted $Cli
        $neutral = ConvertTo-SingleQuoted $NeutralDir
        $log = ConvertTo-SingleQuoted $LogFile
        $extra = ''
        if ($Port -ne 0) { $extra += " '--port' '$Port'" }
        if ($DataDir -ne '') { $extra += " '--data-dir' $(ConvertTo-SingleQuoted $DataDir)" }
        $lines = @(
            '$ErrorActionPreference = ''Continue'''
            '$env:NODE_ENV = ''production'''
            '$env:LOG_LEVEL = ''warn'''
            '$env:RESTORE_RESTART = ''exit'''
            "Set-Location -LiteralPath $neutral"
            "`$log = $log"
            'while ($true) {'
            '    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -LiteralPath $log -Destination "$log.old" -Force }'
            "    & $node $cliQ 'start'$extra 2>&1 | ForEach-Object { `"`$_`" } | Out-File -Append -Encoding utf8 -FilePath `$log"
            '    if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 10 } else { Start-Sleep -Seconds 2 }'
            '}'
        )
        Set-Content -LiteralPath $Wrapper -Value $lines -Encoding UTF8
    }

    function Register-ServerTask {
        $userName = "$env:USERDOMAIN\$env:USERNAME"
        $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Wrapper`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Runs UK Tax Tracker at logon' -Force | Out-Null
    }

    function Stop-ServerTask {
        [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'An internal helper of an installer that has its own confirmations.')]
        param([string]$Cli = '')
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        # Anything the task left running: this install's launcher loop (which would start the app
        # again) and the app itself, matched by their exact paths so no other installation is touched.
        $patterns = @("*$Wrapper*")
        if ($Cli -ne '') { $patterns += "*$Cli*" }
        $leftovers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $commandLine = $_.CommandLine
                $commandLine -and $_.ProcessId -ne $PID -and @($patterns | Where-Object { $commandLine -like $_ }).Count -gt 0
            }
        foreach ($process in $leftovers) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    # Something else may already answer on the port, so the answer has to be this app's.
    function Wait-ForHealth {
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/health" -TimeoutSec 3
                if ($response.StatusCode -eq 200 -and $response.Content -match '"status"\s*:\s*"ok"') { return $true }
            }
            catch {
                Write-Verbose "not up yet: $($_.Exception.Message)"
            }
            Start-Sleep -Seconds 1
        }
        return $false
    }

    # Only a folder that holds this app's files, that is not the profile folder or one of its
    # parents, and that is not a drive root.
    function Test-SafeToPurge {
        param([string]$Path)
        if (-not [IO.Path]::IsPathRooted($Path)) { return $false }
        $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
        if ($full.Length -le [IO.Path]::GetPathRoot($full).TrimEnd('\').Length) { return $false }
        if (-not ((Test-Path -LiteralPath (Join-Path $full 'taxtracker.db')) -or (Test-Path -LiteralPath (Join-Path $full 'config.json')))) { return $false }
        $profileDir = [Environment]::GetFolderPath('UserProfile').TrimEnd('\') + '\'
        return -not $profileDir.StartsWith($full + '\', [StringComparison]::OrdinalIgnoreCase)
    }

    function Remove-AppFile {
        [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'An internal helper of an installer that has its own confirmations.')]
        param()
        foreach ($name in @('run-server.ps1', 'tax-tracker.log', 'tax-tracker.log.old', 'install-state.json')) {
            Remove-Item -LiteralPath (Join-Path $AppDir $name) -Force -ErrorAction SilentlyContinue
        }
        if ((Test-Path -LiteralPath $AppDir) -and -not (Get-ChildItem -LiteralPath $AppDir -Force)) {
            Remove-Item -LiteralPath $AppDir -Force -ErrorAction SilentlyContinue
        }
    }

    function Invoke-Uninstall {
        $state = Read-InstallState
        if ($Prefix -eq '') { $Prefix = Get-StateValue $state 'prefix' }
        if ($TaskName -eq '') { $TaskName = Get-StateValue $state 'taskName' }
        if ($TaskName -eq '') { $TaskName = $DefaultTaskName }
        $data = $DataDir
        if ($data -eq '') { $data = Get-StateValue $state 'dataDir' }
        $cli = ''
        if ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
            $cli = Get-PackageCli
            if ($data -eq '' -and (Test-Path -LiteralPath $cli)) { $data = Get-DataDirFrom (Invoke-TaxTracker $cli @('info')).Output }
        }
        Stop-ServerTask $cli
        Remove-Item -LiteralPath $ShortcutFile -Force -ErrorAction SilentlyContinue
        if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
            $result = Invoke-Npm (@('uninstall', $PackageName) + (Get-NpmGlobalArgument))
            if ($result.ExitCode -ne 0) { Write-Warning "Could not remove the $PackageName package; remove it with: npm uninstall -g $PackageName" }
        }
        Remove-AppFile
        Write-Say 'Removed the scheduled task, shortcut and package.'
        if ($data -eq '') {
            Write-Say 'Your data was not touched.'
            return
        }
        if (-not $Purge) {
            Write-Say "Your data is still in $data (delete it yourself, or run the installer with -Uninstall -Purge)."
            return
        }
        if (-not (Test-SafeToPurge $data)) {
            throw "Refusing to delete '$data': it does not look like a UK Tax Tracker data folder, or it is too broad. Your data was not deleted."
        }
        if (-not (Test-CanPrompt)) { throw '-Purge needs a terminal for its confirmation; your data was not deleted' }
        $answer = Read-Host "This permanently deletes $data, including every backup in it.`nType `"$ConfirmPurgeWord`" to confirm"
        if ($answer -eq $ConfirmPurgeWord) {
            Remove-Item -LiteralPath $data -Recurse -Force
            Write-Say "Deleted $data."
        }
        else {
            Write-Say 'Cancelled. Your data was not deleted.'
        }
    }

    function Invoke-Install {
        $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Warning 'This is running as an administrator. It does not need that, and the app, its data and its task belong to the account that runs it.'
        }
        if ($TaskName -eq '') { $TaskName = $DefaultTaskName }

        Confirm-Node

        if ($FromTarball -ne '') {
            if (-not (Test-Path -LiteralPath $FromTarball)) { throw "No such file: $FromTarball" }
            $spec = $FromTarball
        }
        else {
            $spec = "$PackageName@$Version"
        }

        # A running copy keeps the native password-hashing library locked, which would make an
        # upgrade fail half-way.
        $existing = Get-PackageCli
        if (Test-Path -LiteralPath $existing) { Stop-ServerTask $existing }

        Write-Say "Installing $spec ..."
        $install = Invoke-Npm (@('install', '--no-audit', '--no-fund') + (Get-NpmGlobalArgument) + @($spec))
        if ($install.ExitCode -ne 0) {
            Write-Warning (Get-Failure $install)
            throw "npm could not install $spec"
        }

        $cli = Get-PackageCli
        if (-not (Test-Path -LiteralPath $cli)) { throw "The package installed, but $cli is missing" }

        $dataExisted = $false
        if ($DataDir -ne '') { $dataExisted = Test-Path -LiteralPath $DataDir }
        if ($DataDir -ne '') { $init = Invoke-TaxTracker $cli @('init', '--data-dir', $DataDir) } else { $init = Invoke-TaxTracker $cli @('init') }
        if ($init.ExitCode -ne 0) { throw "tax-tracker init failed:`n$(Get-Failure $init)" }
        Write-Say $init.Output
        $actualData = Get-DataDirFrom $init.Output
        if ($actualData -ne '' -and (Test-PathOverlap $AppDir $actualData)) {
            throw "The data folder ($actualData) and the installer's own folder ($AppDir) overlap; pass a different -AppDir."
        }
        Write-InstallState $actualData

        # Access is narrowed only on a folder this installer created (or the default one), not on a
        # folder someone pointed it at, which may be shared or used by other programs.
        if ($actualData -ne '') {
            if ($DataDir -eq '' -or -not $dataExisted) { Protect-DataDir $actualData }
            else { Write-Say "The existing folder $actualData keeps its current permissions." }
        }

        $serviceStarted = $false
        if (-not $NoService) {
            if (Confirm-Step 'Start UK Tax Tracker automatically when you log on?' $true) {
                Stop-ServerTask $cli
                Write-ServerWrapper $cli
                Register-ServerTask
                Start-ScheduledTask -TaskName $TaskName
                if (Wait-ForHealth) {
                    $serviceStarted = $true
                    Write-Say "UK Tax Tracker is running at $Url"
                }
                else {
                    Write-Warning "The task was started but $Url/health did not answer; see $LogFile"
                }
            }
        }

        if (-not $NoShortcut) {
            if (Confirm-Step 'Add a Start menu shortcut that opens the app?' $true) {
                New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
                Set-Content -LiteralPath $ShortcutFile -Value @('[InternetShortcut]', "URL=$Url") -Encoding ASCII
            }
        }

        $installedVersion = (Invoke-TaxTracker $cli @('--version')).Output
        Write-Say ''
        Write-Say "Installed UK Tax Tracker $installedVersion."
        Write-Say "  Data folder:  $actualData"
        Write-Say "  Backups:      $actualData\backups (a daily backup is on by default)"
        if ($serviceStarted) { Write-Say "  Open:         $Url" } else { Write-Say '  Start it:     tax-tracker start --open' }
        if ($Prefix -ne '') { Write-Say "  Command:      $Prefix\tax-tracker.cmd (add $Prefix to your PATH to run it as tax-tracker)" }
        if ($DataDir -ne '') { Write-Say "  Note:         pass --data-dir `"$actualData`" to tax-tracker commands you run yourself, or they use the default folder." }
        Write-Say '  Uninstall:    run this installer again with -Uninstall   (your data is kept unless you add -Purge)'
        Write-Say ''
        Write-Say 'On first start you create your account and are shown a recovery key. Store it somewhere other'
        Write-Say 'than this computer: it is the only way back in if you forget your passphrase.'
    }

    if ($Uninstall) { Invoke-Uninstall } else { Invoke-Install }
} $PSCmdlet
