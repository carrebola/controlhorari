param([string]$Username = 'cadmin@fpllefia.com')
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $repoPath
$passwordPtr = [IntPtr]::Zero
$pinPtr = [IntPtr]::Zero
try {
    Write-Host "Crear administrador de produccion: $Username"
    Write-Host 'La contrasena y el PIN no se mostraran ni se guardaran en archivos.'
    $passwordSecure = Read-Host 'Elige una contrasena de al menos 10 caracteres' -AsSecureString
    $pinSecure = Read-Host 'Introduce tu PIN real de Timenet' -AsSecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordSecure)
    $pinPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pinSecure)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    $pin = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pinPtr)
    if ($password.Length -lt 10 -or $password.Length -gt 256) { throw 'La contrasena debe tener entre 10 y 256 caracteres.' }
    if ($pin -notmatch '^\d{3,20}$') { throw 'El PIN debe contener entre 3 y 20 digitos.' }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $setupSecret = [Convert]::ToBase64String($bytes)
    @{ ADMIN_SETUP_SECRET = $setupSecret } | ConvertTo-Json -Compress | & node node_modules/wrangler/bin/wrangler.js secret bulk --config cloudflare/wrangler.jsonc
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el alta en Cloudflare.' }
    Write-Host 'Esperando a que Cloudflare active la clave de alta...'
    $setupReady = $false
    for ($probe = 0; $probe -lt 36; $probe++) {
        try {
            $null = Invoke-RestMethod -Method Post -Uri ('https://controlhorari-worker.carrebola-controlhorari.workers.dev/api/admin/users?probe=' + [Guid]::NewGuid().ToString()) -Headers @{ 'x-admin-setup-secret' = $setupSecret } -ContentType 'application/json' -Body '{}'
        } catch {
            $probeStatus = 0
            if ($_.Exception.Response) { $probeStatus = [int]$_.Exception.Response.StatusCode }
            $probeBody = $null
            try { $probeBody = $_.ErrorDetails.Message | ConvertFrom-Json } catch { }
            if ($probeStatus -eq 409 -and $probeBody.message -match 'username') { $setupReady = $true; break }
            if ($probeBody.code -eq 'setup_closed') { throw 'Ya existe una cuenta en produccion. Inicia sesion antes de dar otra alta.' }
        }
        Start-Sleep -Seconds 5
    }
    if (!$setupReady) { throw 'Cloudflare aun no ha activado la clave. No se ha enviado la contrasena ni el PIN. Vuelve a intentarlo mas tarde.' }
    Write-Host 'Clave de alta validada. Creando administrador...'
    $body = @{ username = $Username; displayName = 'Administrador'; password = $password; timenetPin = $pin; role = 'admin' } | ConvertTo-Json -Compress
    $created = $null
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
    try {
        $created = Invoke-RestMethod -Method Post -Uri 'https://controlhorari-worker.carrebola-controlhorari.workers.dev/api/admin/users' -Headers @{ 'x-admin-setup-secret' = $setupSecret } -ContentType 'application/json' -Body $body
        break
    } catch {
        $status = 'sin respuesta'
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 403 -and $attempt -lt 3) { Start-Sleep -Seconds 3; continue }
        $detail = 'Comprueba la conexion y vuelve a intentarlo.'
        if ($_.ErrorDetails.Message) {
            try { $responseBody = $_.ErrorDetails.Message | ConvertFrom-Json; if ($responseBody.message) { $detail = $responseBody.message } } catch { }
        }
        throw "No se pudo crear la cuenta (HTTP $status): $detail"
    }
    }
    if (!$created.ok) { throw 'El servidor no confirmo el alta.' }
    Write-Host "Administrador creado: $($created.user.username)"
    Write-Host 'Entra en https://controlhorari.vercel.app con la contrasena que acabas de elegir. La automatizacion esta desactivada.'
} finally {
    if ($passwordPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr) }
    if ($pinPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pinPtr) }
    $password = $null; $pin = $null; $body = $null; $setupSecret = $null
    Pop-Location
}
