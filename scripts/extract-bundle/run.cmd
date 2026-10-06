@echo off
rem Reads every document in .\docs and writes the answers to .\out.
rem Uses the bundled Node if it is here, otherwise the one on PATH.
setlocal
cd /d "%~dp0"
if exist "node\node.exe" (
  "node\node.exe" orbit-extract.cjs %*
) else (
  node orbit-extract.cjs %*
)
echo.
pause
