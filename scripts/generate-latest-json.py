"""
Gera o latest.json para o auto-updater do Tauri v2.
Uso: python3 generate-latest-json.py <versao> <tag> <repo> <token>
"""
import json, sys, subprocess, urllib.request, urllib.error

version = sys.argv[1]  # ex: 1.0.1
tag     = sys.argv[2]  # ex: v1.0.1
repo    = sys.argv[3]  # ex: fernandopy26/Zabiss-Editor
token   = sys.argv[4]

# Busca assets da release
req = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
    headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
)
with urllib.request.urlopen(req) as r:
    release = json.loads(r.read())

assets = {a["name"]: a["browser_download_url"] for a in release.get("assets", [])}
print(f"Assets encontrados: {list(assets.keys())}")

def find(keywords, exclude=None):
    for name, url in assets.items():
        if all(k in name for k in keywords):
            if exclude and any(e in name for e in exclude):
                continue
            return url
    return None

platforms = {}

win = find([".msi"], [".sig", ".zip"])
if win:
    platforms["windows-x86_64"] = {"url": win, "signature": ""}

linux = find([".AppImage"], [".sig", ".tar.gz"])
if linux:
    platforms["linux-x86_64"] = {"url": linux, "signature": ""}

mac = find([".dmg"], [".sig"])
if mac:
    platforms["darwin-aarch64"] = {"url": mac, "signature": ""}
    platforms["darwin-x86_64"]  = {"url": mac, "signature": ""}

pub_date = subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"]).decode().strip()

latest = {
    "version":   version,
    "notes":     f"Zabiss Editor {tag} — acesse a página de releases para ver as novidades.",
    "pub_date":  pub_date,
    "platforms": platforms,
}

with open("latest.json", "w") as f:
    json.dump(latest, f, indent=2)

print("latest.json gerado:")
print(json.dumps(latest, indent=2))
