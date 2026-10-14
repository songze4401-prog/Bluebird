# Bluebird 数据备份（Windows / PowerShell）
# 把数据目录里的全部数据文件带时间戳拷贝到仓库之外。
# 只读源目录：不修改、不删除、不覆盖源文件；不覆盖已存在的备份目录。
# 运行期产物（.bluebird.lock、*.tmp.*）不备份：锁文件混进备份会在恢复时误报「已有实例在运行」。
#
#   pwsh scripts/blue-backup.ps1
#   pwsh scripts/blue-backup.ps1 -DataDir 'D:\path\to\Bluebird\server\data' -OutDir 'E:\backups'
#
# 源目录默认取 BLUEBIRD_DATA_DIR，否则 <仓库根>/server/data（与服务端一致）；
# 输出根目录默认取 BLUEBIRD_BACKUP_DIR，否则 <用户目录>/bluebird-backups。
# 本文件必须保存为带 UTF-8 BOM：PowerShell 5 用系统 ANSI 代码页解码无 BOM 的文件，中文会乱码且解析失败。

param(
  [string]$DataDir = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $DataDir) {
  $DataDir = if ($env:BLUEBIRD_DATA_DIR) { $env:BLUEBIRD_DATA_DIR } else { Join-Path $repoRoot 'server\data' }
}
if (-not $OutDir) {
  $base = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $OutDir = if ($env:BLUEBIRD_BACKUP_DIR) { $env:BLUEBIRD_BACKUP_DIR } else { Join-Path $base 'bluebird-backups' }
}

if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  Write-Output "✗ 数据目录不存在: $DataDir"
  exit 1
}

function Test-RuntimeFile([string]$name) {
  return ($name -eq '.bluebird.lock' -or $name -like '*.tmp.*')
}

# -Force 才能枚举到 .bluebird.lock 这类点文件
$all = @(Get-ChildItem -LiteralPath $DataDir -File -Force)
$files = @($all | Where-Object { -not (Test-RuntimeFile $_.Name) })
$skipped = @($all | Where-Object { Test-RuntimeFile $_.Name })

if ($files.Count -eq 0) {
  Write-Output "✗ 数据目录里没有可备份的数据文件: $DataDir"
  exit 1
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
$target = Join-Path $OutDir "data-$stamp"
$n = 2
while (Test-Path -LiteralPath $target) {
  $target = Join-Path $OutDir "data-$stamp-$n"
  $n++
}

New-Item -ItemType Directory -Path $target -Force | Out-Null

# 服务端每次落盘都是「写临时文件 + 原子改名」，改名窗口内可能短暂读不到旧文件，故失败重试一次
$fail = $false
foreach ($f in $files) {
  $ok = $false
  for ($attempt = 1; $attempt -le 2 -and -not $ok; $attempt++) {
    try {
      Copy-Item -LiteralPath $f.FullName -Destination $target -Force -ErrorAction Stop
      $ok = $true
    } catch {
      if ($attempt -eq 2) {
        Write-Output "✗ 复制失败（源文件可能正在被写入）: $($f.Name) — $($_.Exception.Message)"
        $fail = $true
      } else {
        Start-Sleep -Milliseconds 800
      }
    }
  }
}

if ($fail) {
  Write-Output "✗ 复制未完成，已保留部分文件: $target"
  exit 1
}

$skippedNames = if ($skipped.Count) { ($skipped | ForEach-Object { $_.Name }) -join ' ' } else { '(none)' }
$lines = @(
  '# Bluebird data backup',
  "# source:  $DataDir",
  "# utc:     $stamp",
  "# skipped: $skippedNames",
  '# files:   (name  bytes  sha256)'
)
$count = 0
$total = 0

foreach ($f in $files) {
  $srcHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  $lines += "$($f.Name)  $($f.Length)  $srcHash"
  $count++
  $total += $f.Length

  $dst = Join-Path $target $f.Name
  if (-not (Test-Path -LiteralPath $dst)) {
    Write-Output "✗ 缺少副本: $($f.Name)"
    $fail = $true
    continue
  }
  if ((Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash -ne $srcHash) {
    Write-Output "✗ 校验不一致: $($f.Name)"
    $fail = $true
  }
}

Set-Content -LiteralPath (Join-Path $target 'MANIFEST.txt') -Value $lines -Encoding UTF8

if ($fail) {
  Write-Output "✗ 校验失败，备份可能不完整: $target"
  exit 1
}

Write-Output "✓ 备份完成：$count 个文件，$total 字节，SHA-256 已校验"
Write-Output "  源:   $DataDir"
Write-Output "  目标: $target"
if ($skipped.Count) {
  Write-Output "  未备份（运行期产物）: $skippedNames"
}
Write-Output "  恢复：停服 → 用该目录内容替换数据目录 → 启动（见 AGENTS.md「Data safety & backup」）"
