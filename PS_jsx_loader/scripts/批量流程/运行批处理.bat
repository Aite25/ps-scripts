@echo off
chcp 65001 >nul
rem ==========================================================================
rem  一键批处理：自动扫描常见 Photoshop 安装位置，然后交给 ps 04 脚本处理
rem  （脚本会自动用你上次记住的设置，不弹选项窗；处理结果写在输出文件夹的
rem    _日志 与 _批处理结果.txt 里）
rem ==========================================================================
setlocal enabledelayedexpansion

set "JSX=%~dp0ps 00 批处理_整个文件夹.jsx"
set "PS=E:\Adobe\Adobe Photoshop 2023\Photoshop.exe"
rem （已按你的要求绑定 2023；要换版本就改这一行）

rem --- 先找常见安装位置（2023 优先，因为脚本在 2023 上验证过） ---
for %%v in (2023 2024 2025 2026 2022) do (
  for %%d in ("C:\Program Files\Adobe" "D:\Adobe" "E:\Adobe" "D:\Program Files\Adobe" "E:\Program Files\Adobe") do (
    if not defined PS if exist "%%~d\Adobe Photoshop %%v\Photoshop.exe" set "PS=%%~d\Adobe Photoshop %%v\Photoshop.exe"
  )
)

rem --- 再兜底：从注册表里找 ---
if not defined PS (
  for /f "tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\Adobe\Photoshop" /s /v "ApplicationPath" 2^>nul ^| findstr /i "ApplicationPath"') do (
    if not defined PS if exist "%%b\Photoshop.exe" set "PS=%%b\Photoshop.exe"
  )
)

if not defined PS (
  echo.
  echo [!] 没找到 Photoshop.exe
  echo     请用记事本打开这个 .bat，把下面这行改成你的路径：
  echo         set "PS=C:\Program Files\Adobe\Adobe Photoshop 2023\Photoshop.exe"
  echo.
  pause
  exit /b 1
)

if not exist "%JSX%" (
  echo [!] 找不到脚本：%JSX%
  pause
  exit /b 1
)

rem --- 写"自动模式"标记：脚本看到它就不弹选项窗，直接用记住的设置 ---
echo auto=1 > "%TEMP%\psjsx_batch_auto.txt"

echo ============================================================
echo   Photoshop : %PS%
echo   脚本      : %JSX%
echo   模式      : 自动（用上次记住的文件夹与保存方式）
echo   提示      : 输出文件夹里的 _日志 有详细计时与失败明细
echo ============================================================
echo.
echo 正在启动 Photoshop 并开始批处理...
start "" "%PS%" "%JSX%"
echo 已启动。可以最小化这个窗口，处理期间不要关 Photoshop。
timeout /t 6 >nul
exit /b 0
