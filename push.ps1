# 一次性把本地仓库推到 GitHub。
#
# 用法（在仓库目录里）：
#   powershell -ExecutionPolicy Bypass -File push.ps1 https://github.com/<you>/dsh-plugins
#
# 推的时候 Git Credential Manager 会弹一次 GitHub 登录窗，登完就把凭据存进 Windows 凭据管理器，
# 以后这台机器 git push 不用再登。

param(
    [Parameter(Mandatory = $true)][string]$Repo
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$match = [regex]::Match($Repo, '^https://github\.com/[^/]+/[^/]+?/?(?:\.git)?$')
if (-not $match.Success) {
    throw "仓库地址格式不对：$Repo（要 https://github.com/<owner>/<repo>）"
}

$Repo = $Repo.TrimEnd('/') -replace '\.git$', ''
if ((git remote) -contains 'origin') { git remote remove origin }
git remote add origin "$Repo.git"

git branch -M main
Write-Host "推送 $Repo (main) ..." -ForegroundColor Cyan
git push -u origin main

Write-Host ""
Write-Host "完成。把这段地址加进 DSH 的「插件 → 发现 → 索引源」：" -ForegroundColor Green
$raw = $Repo -replace '^https://github\.com/', 'https://raw.githubusercontent.com/'
Write-Host "  $raw/main/index.json" -ForegroundColor Yellow
