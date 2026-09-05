@echo off
REM ===========================================================================
REM VoidCode AI - Quick Tunnel Launcher (No Account Required)
REM
REM Opens TWO free Cloudflare tunnels with random subdomains:
REM   - Backend:  https://xxxxx.trycloudflare.com  (port 8000) — Windows
REM   - Frontend: https://yyyyy.trycloudflare.com  (port 3000) — Windows
REM
REM Both tunnels run on Windows because the backend is now a Docker container
REM bound to localhost:8000 — reachable directly from Windows cloudflared.
REM (Previously the backend tunnel ran inside WSL2 because uvicorn ran there.)
REM
REM IMPORTANT: After starting, copy the tunnel URLs and set them in
REM   apps/web/.env.local:
REM     NEXT_PUBLIC_API_URL = backend tunnel URL
REM     AUTH_URL            = frontend tunnel URL
REM   Then restart the frontend (pnpm dev).
REM ===========================================================================

echo.
echo ============================================
echo  VoidCode AI - Cloudflare Tunnels
echo ============================================
echo.
echo Starting TWO tunnel windows (both on Windows)...
echo   - Backend tunnel:  port 8000 (Docker container)
echo   - Frontend tunnel: port 3000 (Next.js dev server)
echo.
echo After both tunnels start, you will see URLs like:
echo   https://some-random-words.trycloudflare.com
echo.
echo STEP 1: Copy the BACKEND tunnel URL
echo STEP 2: Copy the FRONTEND tunnel URL
echo STEP 3: Put them in apps/web/.env.local:
echo           NEXT_PUBLIC_API_URL = backend URL
echo           AUTH_URL            = frontend URL
echo STEP 4: Restart the frontend (pnpm dev)
echo STEP 5: Share the FRONTEND tunnel URL with users
echo.

REM Start backend tunnel on Windows (Docker container exposes port 8000 to host)
start "Tunnel: Backend (8000)" cmd /k "echo [BACKEND TUNNEL - port 8000] && echo. && cloudflared tunnel --edge-ip-version 4 --protocol quic --url http://127.0.0.1:8000"

REM Wait a moment so the windows don't collide
timeout /t 2 /nobreak > nul

REM Start frontend tunnel on Windows
start "Tunnel: Frontend (3000)" cmd /k "echo [FRONTEND TUNNEL - port 3000] && echo. && cloudflared tunnel --edge-ip-version 4 --protocol quic --url http://127.0.0.1:3000"

echo.
echo Tunnel windows opened. Watch them for your public URLs.
echo Press any key to exit this launcher...
pause > nul
