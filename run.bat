@echo off
cd /d "%~dp0"
echo ==== %date% %time% ==== >> logs\run.log
node --env-file=.env src\index.js >> logs\run.log 2>&1
