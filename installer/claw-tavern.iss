; Claw Tavern — Inno Setup Installer Script
;
; Usage:
;   iscc installer\claw-tavern.iss
;
; Prerequisites:
;   - Inno Setup 6+ installed (https://jrsoftware.org/isinfo.php)
;   - Run "bun scripts/build-standalone.ts" first to produce dist/
;
; Output:
;   installer\output\claw-tavern-setup.exe

#define AppName "Claw Tavern"
#define AppVersion "0.1.0"
#define AppPublisher "Claw Tavern"
#define AppExeName "claw-tavern.exe"
#define AppURL "https://github.com/user/claw-tavern"

[Setup]
AppId={{B7E8F1A2-3D4C-5E6F-8A9B-0C1D2E3F4A5B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir=installer\output
OutputBaseFilename=claw-tavern-setup
SetupIconFile=
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Uninstall: remove program files only.
; User data in %LOCALAPPDATA%\ClawTavern is NOT touched.
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Main executable
Source: "dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; Frontend static files
Source: "dist\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
// Verify dist/ exists before installation begins
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
