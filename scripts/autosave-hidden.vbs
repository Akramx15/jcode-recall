' jcode-recall: run the autosave watcher with no console window.
'
' Alternative to the scheduled task (scripts\install-windows.ps1 -Autosave).
' Use this if you prefer a long-lived watcher started at logon:
'
'   1. Press Win+R, run:  shell:startup
'   2. Put a shortcut to this file in that folder (or copy the file there).
'   3. Double-click it once to start the watcher immediately.
'
' The watcher polls ~/.jcode/sessions (project scope, last 7 days) and imports
' changed sessions. Stop it with Task Manager (wscript.exe) or sign out.
'
' If you cloned the repo somewhere unusual, set RECALL_REPO below; when empty
' the parent folder of this scripts\ directory is used.
Option Explicit

Dim RECALL_REPO
RECALL_REPO = ""

Dim shell, fso, scriptDir, repo, entry, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
If RECALL_REPO = "" Then
    repo = fso.GetParentFolderName(scriptDir)
Else
    repo = RECALL_REPO
End If
entry = repo & "\bin\recall.js"

If Not fso.FileExists(entry) Then
    MsgBox "Cannot find " & entry & vbCrLf & _
           "Set RECALL_REPO at the top of this file.", vbExclamation, "jcode-recall"
    WScript.Quit 1
End If

command = """" & "node.exe" & """ """ & entry & """ autosave --watch"
' 0 = hidden window, False = do not wait for it to exit.
shell.Run command, 0, False
