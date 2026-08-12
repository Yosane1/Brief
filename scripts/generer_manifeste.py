#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Répercute les réglages Airtable sur l'identité de l'application installée.

Pourquoi un script, et pas du JavaScript comme le reste des réglages : le nom,
la description, l'icône et les couleurs d'une application installée sont lus
par le système d'exploitation dans `manifest.webmanifest`, **avant** que la
moindre ligne de JavaScript ne s'exécute. Aucun code de la page ne peut les
changer après coup. Ils doivent donc être écrits dans le fichier.

Le script régénère :
    manifest.webmanifest    nom, description, couleurs
    icones/*.png            aux couleurs de l'accent
    index.html              titre, description et nom iOS

Usage :
    python scripts/generer_manifeste.py

Après exécution, re-téléverser ces fichiers. Sur un téléphone où l'application
est déjà installée, il faut la désinstaller puis la réinstaller : le système ne
relit le manifeste qu'à l'installation.
"""
import json
import os
import re
import sys

DOSSIER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from airtable import select                    # noqa: E402
from generer_icones import dessiner            # noqa: E402

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

# Le nom et la couleur ne s'inventent pas : une valeur de repli produirait une
# application au nom et à l'apparence de personne, ce qui est indiscernable du
# bon fonctionnement. Mieux vaut s'arrêter ici, au moment où c'est réparable.
REQUIS = ("app_nom", "couleur_accent")

DEFAUTS = {
    "app_point": "",
    "app_baseline": "",
    "app_description": "",
}


def lire_reglages():
    valeurs = dict(DEFAUTS)
    attendues = set(REQUIS) | set(DEFAUTS)
    for r in select("reglages"):
        cle = r["fields"].get("Clé")
        val = (r["fields"].get("Valeur") or "").strip()
        if cle in attendues and val:
            valeurs[cle] = val

    manquantes = [c for c in REQUIS if not valeurs.get(c)]
    if manquantes:
        sys.exit(f"✗ Réglage(s) absent(s) de la base : {', '.join(manquantes)}.\n"
                 f"  Renseignez-les dans la table Réglages avant de régénérer "
                 f"l'identité de l'application.")
    return valeurs


def ecrire_manifeste(r):
    nom_complet = f"{r['app_nom']}{r['app_point']}".strip()
    manifeste = {
        "name": f"{nom_complet} · {r['app_baseline']}".rstrip(" ·"),
        "short_name": r["app_nom"][:12],
        "description": r["app_description"],
        "lang": "fr",
        "dir": "ltr",
        "start_url": "./index.html",
        "scope": "./",
        "id": "./",
        "display": "standalone",
        "display_override": ["standalone", "minimal-ui"],
        "orientation": "portrait-primary",
        "background_color": "#ffffff",
        "theme_color": r["couleur_accent"],
        "categories": ["news", "magazines", "education"],
        "icons": [
            {"src": "icones/icone-192.png", "sizes": "192x192",
             "type": "image/png", "purpose": "any"},
            {"src": "icones/icone-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "any"},
            {"src": "icones/icone-maskable-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "L'édition du jour", "url": "./index.html#/",
             "icons": [{"src": "icones/icone-192.png", "sizes": "192x192"}]},
            {"name": "Archives", "url": "./index.html#/archives"},
            {"name": "Explorer", "url": "./index.html#/explorer"},
        ],
    }
    chemin = os.path.join(DOSSIER, "manifest.webmanifest")
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump(manifeste, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return manifeste


def ecrire_icones(accent):
    dossier = os.path.join(DOSSIER, "icones")
    os.makedirs(dossier, exist_ok=True)
    for nom, taille, maskable in [
        ("icone-192.png", 192, False),
        ("icone-512.png", 512, False),
        ("icone-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]:
        with open(os.path.join(dossier, nom), "wb") as f:
            f.write(dessiner(taille, accent, maskable))


def patcher_index(r, titre_complet):
    """Met à jour les balises que le JavaScript ne peut pas atteindre à temps."""
    chemin = os.path.join(DOSSIER, "index.html")
    with open(chemin, encoding="utf-8") as f:
        html = f.read()

    remplacements = [
        (r"<title>.*?</title>", f"<title>{titre_complet}</title>", 1),
        (r'(<meta name="description" content=)".*?"',
         lambda m: f'{m.group(1)}"{r["app_description"]}"', 1),
        (r'(<meta name="apple-mobile-web-app-title" content=)".*?"',
         lambda m: f'{m.group(1)}"{r["app_nom"]}"', 1),

        # Le logo apparaît avant que le JavaScript n'ait lu la base — sur le
        # portail comme dans l'en-tête. Il porte donc le nom réel, déposé ici,
        # et non un nom d'usine écrit dans le fichier. Les deux occurrences
        # sont remplacées.
        (r'(<b data-reglage="app_nom">).*?(</b><span data-reglage="app_point">).*?(</span>)',
         lambda m: f'{m.group(1)}{r["app_nom"]}{m.group(2)}{r["app_point"]}{m.group(3)}', 0),
    ]
    for motif, remplacement, combien in remplacements:
        html, n = re.subn(motif, remplacement, html, count=combien, flags=re.S)
        if not n:
            print(f"  ! motif introuvable dans index.html : {motif}")

    with open(chemin, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)


if __name__ == "__main__":
    r = lire_reglages()
    manifeste = ecrire_manifeste(r)
    ecrire_icones(r["couleur_accent"])
    patcher_index(r, manifeste["name"])

    print("Identité de l'application régénérée :")
    print(f"  nom installé   {manifeste['short_name']}")
    print(f"  titre complet  {manifeste['name']}")
    print(f"  description    {manifeste['description'][:70]}…")
    print(f"  accent         {r['couleur_accent']}")
    print("\nÀ re-téléverser : manifest.webmanifest, index.html, icones/")
    print("Sur un téléphone où l'app est déjà installée, la désinstaller puis")
    print("la réinstaller — le manifeste n'est relu qu'à l'installation.")
