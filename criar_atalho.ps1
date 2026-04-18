$ws = New-Object -ComObject WScript.Shell
$desktop = [System.Environment]::GetFolderPath('Desktop')
$s = $ws.CreateShortcut($desktop + '\Gravador de Reuniao.lnk')
$s.TargetPath = 'C:\Users\eduar\Gravador-de-Reuni-es\iniciar_gui.bat'
$s.WorkingDirectory = 'C:\Users\eduar\Gravador-de-Reuni-es'
$s.WindowStyle = 1
$s.IconLocation = 'C:\Windows\System32\mmsys.cpl,0'
$s.Description = 'Gravador de Reuniao'
$s.Save()
Write-Host 'Atalho criado!'
