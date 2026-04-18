$proj = 'C:\Users\eduar\Gravador-de-Reuni-es'
$path = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if ($path -notlike "*$proj*") {
    $novo = $path + ';' + $proj
    [System.Environment]::SetEnvironmentVariable('PATH', $novo, 'User')
    Write-Host 'PATH atualizado! Abra um novo terminal para testar.'
} else {
    Write-Host 'Pasta ja esta no PATH.'
}
