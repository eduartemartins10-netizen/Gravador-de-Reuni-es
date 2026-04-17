@echo off
chcp 65001 >nul
title Instalador — Gravador de Reuniao
color 0A

echo.
echo ============================================
echo   INSTALADOR — Gravador de Reuniao
echo ============================================
echo.
echo Este instalador configura o programa neste
echo computador. Rode apenas UMA vez.
echo.
pause

REM 1. Verificar se o Python esta instalado
echo.
echo [1/5] Verificando Python...
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERRO: Python nao encontrado neste computador.
    echo.
    echo Instale o Python primeiro:
    echo   1. Acesse python.org
    echo   2. Baixe a versao mais recente para Windows
    echo   3. Na instalacao, MARQUE "Add Python to PATH"
    echo   4. Depois rode este instalador novamente.
    echo.
    pause
    exit /b 1
)
python --version
echo OK!

REM 2. Instalar bibliotecas
echo.
echo [2/5] Instalando bibliotecas (pode demorar alguns minutos)...
pip install -r "%~dp0requirements.txt"
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERRO ao instalar bibliotecas. Verifique a conexao com a internet.
    pause
    exit /b 1
)
echo OK!

REM 3. Configurar chave da API Gemini
echo.
echo [3/5] Configurando chave da API Gemini...
echo.
echo Se voce ainda nao tem a chave:
echo   1. Acesse aistudio.google.com
echo   2. Faca login com a conta Google
echo   3. Clique em "Get API key" e depois "Create API key"
echo   4. Copie a chave gerada
echo.
set /p CHAVE="Cole a chave da API aqui e pressione ENTER: "
if "%CHAVE%"=="" (
    echo Nenhuma chave informada. Pule este passo e configure depois com:
    echo   setx GEMINI_API_KEY "sua_chave"
) else (
    setx GEMINI_API_KEY "%CHAVE%" >nul
    echo Chave configurada! (ative reiniciando o terminal)
)

REM 4. Baixar modelo do Whisper antecipadamente
echo.
echo [4/5] Baixando modelo de transcricao (244 MB, pode demorar)...
python -c "import sys; sys.path.insert(0,r'%~dp0'); from unittest.mock import MagicMock; sys.modules['av']=MagicMock(); from faster_whisper import WhisperModel; WhisperModel('medium', device='cpu', compute_type='int8'); print('Modelo baixado!')"
echo OK!

REM 5. Criar pastas
echo.
echo [5/5] Criando pastas...
mkdir "%~dp0gravacoes" 2>nul
mkdir "%~dp0transcricoes" 2>nul
mkdir "%~dp0atas" 2>nul
echo OK!

echo.
echo ============================================
echo   INSTALACAO CONCLUIDA!
echo ============================================
echo.
echo Para usar:
echo   Clique duas vezes em "iniciar.bat"
echo.
echo IMPORTANTE: feche e reabra o terminal para
echo a chave da API funcionar.
echo.
pause
