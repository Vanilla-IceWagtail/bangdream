@echo off
chcp 65001 >nul
title 合成邦多利皇帝
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，无法启动本地服务器。
  echo   你可以直接双击 index.html 打开游戏（但导入的图片可能存不住）。
  echo.
  pause
  exit /b 1
)
node server.cjs
pause
