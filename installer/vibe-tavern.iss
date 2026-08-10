; Vibe Tavern — Inno Setup Installer Script
;
; Usage:
;   iscc installer\vibe-tavern.iss
;   bun scripts/build-installer.ts
;
; Prerequisites:
;   - Inno Setup 6+ installed (https://jrsoftware.org/isinfo.php)
;   - Run "bun scripts/build-standalone.ts" first to produce out\standalone\
;
; Output:
;   out\installer\vibe-tavern-setup.exe
;
; NOTE: All Source paths are relative to ProjectRoot (passed via /D or defaulting
; to the repo root). This allows ISCC to find out\standalone\ regardless of cwd.

; Allow overriding from command line: iscc /DProjectRoot=N:\path installer\vibe-tavern.iss
#if !Defined(ProjectRoot)
  #define ProjectRoot ".."
#endif

#define AppName "Vibe Tavern"
#if !Defined(AppVersion)
  #define AppVersion "0.0.0-dev"
#endif
#define AppPublisher "Vibe Tavern"
#define AppExeName "vibe-tavern.exe"
#define AppURL "https://github.com/Noineri/vibe_tavern"

; Compression defaults to what ships. CI overrides it (see build-installer.ts
; --fast-compression): there the installer is thrown away and only has to prove
; it compiles, and lzma2/ultra64 over a solid block spends ~95s of a ~108s step
; squeezing a ~100 MB binary nobody downloads. Never override this for a release.
#if !Defined(Compression)
  #define Compression "lzma2/ultra64"
#endif
#if !Defined(SolidCompression)
  #define SolidCompression "yes"
#endif

[Setup]
AppId={{B7E8F1A2-3D4C-5E6F-8A9B-0C1D2E3F4A5B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir={#ProjectRoot}\out\installer
OutputBaseFilename=vibe-tavern-setup
SetupIconFile={#ProjectRoot}\apps\web\public\logo.ico
Compression={#Compression}
SolidCompression={#SolidCompression}
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; Uninstall: remove program files only.
; User data in %LOCALAPPDATA%\VibeTavern is NOT touched.
UninstallDisplayIcon={app}\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Main executable
Source: "{#ProjectRoot}\out\standalone\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; Frontend static files
Source: "{#ProjectRoot}\out\standalone\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
; Tokenizer data files
Source: "{#ProjectRoot}\out\standalone\tokenizers\*"; DestDir: "{app}\tokenizers"; Flags: ignoreversion recursesubdirs createallsubdirs
; DB migration files
Source: "{#ProjectRoot}\out\standalone\drizzle\*"; DestDir: "{app}\drizzle"; Flags: ignoreversion recursesubdirs createallsubdirs
; Prompt files
Source: "{#ProjectRoot}\out\standalone\prompts\*"; DestDir: "{app}\prompts"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
// Verify packaged files exist before installation begins
function InitializeSetup(): Boolean;
begin
  Result := True;
end;

// Write a marker file next to the executable so the running app can detect
// it was installed by Inno Setup (vs. a zip extracted under Program Files).
// detectInstallKind() in update-orchestrator.ts reads this file.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\.vibe-tavern-install'), 'inno-setup', False);
end;
