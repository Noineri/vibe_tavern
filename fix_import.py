import os

path = r"n:\janitor_characters\rp_platform\apps\web\src\components\BuildMode.tsx"
with open(path, "rb") as f:
    data = f.read()

old = b'app-client.js";\r\n\n\nimport { CharacterForm'
new = b'app-client.js";\r\nimport { cn } from "../lib/cn.js";\r\nimport { CharacterForm'
data = data.replace(old, new)

with open(path, "wb") as f:
    f.write(data)

print("OK")
