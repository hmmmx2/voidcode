@echo off
REM ===========================================================================
REM VoidCode AI - Quick API Tunnel (No Account Required)
REM
REM ONE tunnel, to the API. This script used to open two -- one for the API and
REM one for a Next.js app on :3000 that users would visit -- and then told you to
REM paste both URLs into apps/web/.env.local as NEXT_PUBLIC_API_URL and AUTH_URL.
REM
REM None of that applies any more. The logged-in UI is the desktop application,
REM which people install rather than visit, so there is no front end to share a
REM link to; and the website that remains holds no session and calls no API, so
REM those two variables are read by nothing. A stale value left in .env.local was
REM a documented time sink, which is why this comment is longer than the script.
REM
REM What a tunnel is still for: giving a desktop app on somebody else's machine a
REM reachable HTTPS address for the API on this one. See docs/specs/TUNNEL_SETUP.md.
REM
REM PORT: 8020, which is what the desktop app defaults to and what
REM apps/api/tests/conftest.py expects. The GPU container publishes 8000 instead
REM -- pass it as the first argument if that is what you are running:
REM
REM     start-tunnels.bat 8000
REM ===========================================================================

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=8020

echo.
echo ============================================
echo  VoidCode AI - API tunnel (port %PORT%)
echo ============================================
echo.
echo Opening one tunnel to http://127.0.0.1:%PORT%
echo.
echo When it prints a URL like https://some-random-words.trycloudflare.com,
echo start the desktop app against it FROM SOURCE:
echo.
echo   cd desktop
echo   cross-env VOIDCODE_API_URL=https://some-random-words.trycloudflare.com/v1 npm run dev
echo.
echo The /v1 suffix is part of the address. A PACKAGED build ignores that
echo variable on purpose -- build it with VOIDCODE_BUILD_API_URL instead.
echo.

start "Tunnel: API (%PORT%)" cmd /k "echo [API TUNNEL - port %PORT%] && echo. && cloudflared tunnel --edge-ip-version 4 --protocol quic --url http://127.0.0.1:%PORT%"

echo Tunnel window opened. Watch it for the public URL.
echo Press any key to exit this launcher...
pause > nul
endlocal
