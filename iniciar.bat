@echo off
chcp 65001 >nul
title Gravador de Reuniao
cd /d "%~dp0"
REM Configure sua chave rodando instalar.bat uma vez
REM ou defina manualmente: set GEMINI_API_KEY=sua_chave_aqui
python interface.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo Ocorreu um erro. Procure o responsavel de TI.
    echo.
    pause
)
