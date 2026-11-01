$ErrorActionPreference = "Continue"
$names = @("py.exe","python.exe","pythonw.exe")
Get-CimInstance Win32_Process | Where-Object {
  $names -contains $_.Name -and $_.CommandLine -like "*wechat_group_uia.py*"
} | ForEach-Object {
  $_.CommandLine
}