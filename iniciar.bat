@echo off
chcp 65001 >nul
title Gravador de Reuniao
cd /d "%~dp0"
python reuniao.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo Ocorreu um erro. Procure o responsavel de TI.
    echo.
    pause
)
