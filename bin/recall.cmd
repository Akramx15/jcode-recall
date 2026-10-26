@echo off
rem Windows shim so `recall` works without npm link.
rem Usage: put this folder on PATH, or call bin\recall.cmd directly.
node "%~dp0recall.js" %*
