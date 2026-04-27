# Empacota o build em um ZIP pronto para distribuir.
# Executar apos rodar 'pyinstaller build.spec'.

$origem = Join-Path $PSScriptRoot "dist\GravadorDeReunioes"
$destino = Join-Path $PSScriptRoot "GravadorDeReunioes.zip"

if (-not (Test-Path $origem)) {
    Write-Host "Erro: pasta 'dist\GravadorDeReunioes' nao encontrada." -ForegroundColor Red
    Write-Host "Rode primeiro: pyinstaller build.spec"
    exit 1
}

if (Test-Path $destino) {
    Remove-Item $destino
}

Write-Host "Compactando..." -ForegroundColor Cyan
Compress-Archive -Path "$origem\*" -DestinationPath $destino -CompressionLevel Optimal

$tamanho = [math]::Round((Get-Item $destino).Length / 1MB, 1)
Write-Host ""
Write-Host "Pronto!" -ForegroundColor Green
Write-Host "Arquivo: $destino"
Write-Host "Tamanho: $tamanho MB"
Write-Host ""
Write-Host "Envie este ZIP pros usuarios. Eles so precisam:"
Write-Host "  1. Extrair o ZIP"
Write-Host "  2. Clicar duas vezes em GravadorDeReunioes.exe"
