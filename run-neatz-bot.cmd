@echo off
rem neatz-bot launcher — the bot itself holds a singleton lock (port 47391),
rem so a second launch exits instantly; safe to trigger repeatedly.
cd /d C:\Users\zachn\IdeaProjects\neatz-bot
"C:\Program Files\nodejs\node.exe" index.js >> "%LOCALAPPDATA%\neatz-bot.log" 2>&1
