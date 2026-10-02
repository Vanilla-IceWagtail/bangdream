@echo off
chcp 65001 >nul
title 合成邦多利皇帝 · 共享排行榜
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，无法启动服务器。
  echo.
  pause
  exit /b 1
)
echo.
echo   正在启动「多人共享排行榜」模式...
echo   同一个 Wi-Fi / 局域网下的人，用下面打印出来的地址打开就能进同一张榜。
echo   关掉这个窗口 = 关掉服务器。
echo.
node server.cjs --lan
pause
