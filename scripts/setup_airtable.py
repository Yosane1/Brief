#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Provisionne (de façon idempotente) le schéma Airtable de l'application Brief.

Usage :
    python scripts/setup_airtable.py

Le script peut être relancé sans risque : il ne crée que ce qui manque.
"""
import json
import os
import subprocess
import sys
import tempfile

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

TOKEN = os.environ.get("AIRTABLE_TOKEN") or \
    "patDnefT5sQlQc2L1.7388f732d1cac15a74705c77a61c2d0be78892cb5594d5ee6d0e9d0bf1683b01"
BASE_ID = os.environ.get("AIRTABLE_BASE_ID") or "appzxFhyARS0LjDFc"
API = "https://api.airtable.com/v0"

# --------------------------------------------------------------------------- #
# Helpers HTTP
# --------------------------------------------------------------------------- #


def call(method, path, payload=None):
    """Appel API via curl : le magasin de certificats Python est inutilisable
    derrière l'inspection TLS de certains postes Windows."""
    cmd = [
        "curl", "-s", "-X", method, f"{API}{path}",
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Content-Type: application/json",
    ]
    tmp = None
    if payload is not None:
        tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        json.dump(payload, tmp, ensure_ascii=False)
        tmp.close()
        cmd += ["--data-binary", f"@{tmp.name}"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    finally:
        if tmp:
            os.unlink(tmp.name)
    if out.returncode != 0:
        raise SystemExit(f"[curl {out.returncode}] {method} {path}\n{out.stderr}")
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"[réponse illisible] {method} {path}\n{out.stdout[:800]}")
    if isinstance(res, dict) and "error" in res:
        raise SystemExit(
            f"[API] {method} {path}\n{json.dumps(res['error'], ensure_ascii=False, indent=2)}"
            + (f"\npayload: {json.dumps(payload, ensure_ascii=False)[:600]}" if payload else "")
        )
    return res


def schema():
    return call("GET", f"/meta/bases/{BASE_ID}/tables")["tables"]


# --------------------------------------------------------------------------- #
# Raccourcis de définition de champs
# --------------------------------------------------------------------------- #

SELECT_COLORS = [
    "redLight2", "orangeLight2", "yellowLight2", "greenLight2", "tealLight2",
    "cyanLight2", "blueLight2", "purpleLight2", "pinkLight2", "grayLight2",
]


def text(name):
    return {"name": name, "type": "singleLineText"}


def long(name):
    return {"name": name, "type": "multilineText"}


def num(name, precision=0):
    return {"name": name, "type": "number", "options": {"precision": precision}}


def date(name):
    return {
        "name": name,
        "type": "date",
        "options": {"dateFormat": {"name": "iso"}},
    }


def datetime_(name):
    return {
        "name": name,
        "type": "dateTime",
        "options": {
            "dateFormat": {"name": "iso"},
            "timeFormat": {"name": "24hour"},
            "timeZone": "Europe/Paris",
        },
    }


def check(name, color="greenBright"):
    return {
        "name": name,
        "type": "checkbox",
        "options": {"icon": "check", "color": color},
    }


def select(name, choices):
    return {
        "name": name,
        "type": "singleSelect",
        "options": {
            "choices": [
                {"name": c, "color": SELECT_COLORS[i % len(SELECT_COLORS)]}
                for i, c in enumerate(choices)
            ]
        },
    }


def url(name):
    return {"name": name, "type": "url"}


def email(name):
    return {"name": name, "type": "email"}


def link(name, table_id):
    return {
        "name": name,
        "type": "multipleRecordLinks",
        "options": {"linkedTableId": table_id},
    }


# --------------------------------------------------------------------------- #
# Vocabulaire éditorial
# --------------------------------------------------------------------------- #

RUBRIQUES = [
    "On rembobine",          # l'essentiel du jour
    "Tout s'explique",       # le décryptage
    "On fait le point",      # synthèse d'un sujet dense
    "C'est leur avis",       # analyses / opinions
    "Ça se voit",            # infographie, carte, graphique
    "C'est qui ?",           # portrait
    "Ça alors",              # insolite
    "Ça peut servir",        # pratique
    "Ça vaut un clic",       # recommandations
    "À vous de jouer",       # jeu
    "On revient au début",   # histoire (week-end)
    "On rembobine la semaine",
    "C'est quoi ?",          # définition (week-end)
]

THEMATIQUES = [
    "France", "International", "Économie", "Environnement", "Sciences",
    "Tech", "Culture", "Sport", "Société", "Santé",
]

# --------------------------------------------------------------------------- #
# Définition des tables
# --------------------------------------------------------------------------- #


def tables_spec(existing):
    """Retourne la spec des tables. `existing` sert à résoudre les liens."""
    ids = {t["name"]: t["id"] for t in existing}

    spec = []

    spec.append({
        "name": "Éditions",
        "description": "Une ligne = un brief quotidien. C'est l'unité publiée dans l'app.",
        "fields": [
            text("Titre"),
            date("Date"),
            num("Numéro"),
            select("Type", ["Quotidienne", "Extra du samedi", "Édition spéciale"]),
            select("Statut", ["Brouillon", "Programmée", "Publiée", "Archivée"]),
            long("Édito"),
            long("Résumé"),
            num("Temps de lecture"),
            datetime_("Publiée le"),
            url("Image de une"),
            text("Crédit image"),
            check("Notification envoyée", "blueBright"),
            select("Généré par", ["Claude Code Cloud", "Manuel", "Import"]),
            text("Slug"),
        ],
    })

    spec.append({
        "name": "Articles",
        "description": "Le contenu du brief, découpé par rubrique. Contenu en Markdown.",
        "fields": [
            text("Titre"),
            select("Rubrique", RUBRIQUES),
            select("Thématique", THEMATIQUES),
            num("Ordre"),
            long("Chapô"),
            long("Contenu"),
            text("Chiffre clé"),
            text("Légende chiffre"),
            long("Citation"),
            text("Auteur citation"),
            url("Image"),
            text("Légende image"),
            long("Sources"),
            text("Mots-clés"),
            date("Date"),
            check("À la une", "redBright"),
            num("Temps de lecture"),
        ],
        # champs liés ajoutés dans un second temps (dépendance d'ID)
        "links": [("Édition", "Éditions")],
    })

    spec.append({
        "name": "Clients",
        "description": "Accès à l'application. Un jeton = un abonnement, valable entre deux dates.",
        "fields": [
            text("Nom"),
            email("Email"),
            text("Jeton"),
            date("Date début"),
            date("Date fin"),
            check("Utilisateurs illimités", "purpleBright"),
            num("Places"),
            check("Actif"),
            select("Plan", ["Essai", "Mensuel", "Annuel", "Institution", "Offert"]),
            check("Notifications", "blueBright"),
            select("Rôle", ["Lecteur", "Éditeur", "Admin"]),
            datetime_("Dernière connexion"),
            num("Connexions"),
            long("Notes"),
        ],
    })

    spec.append({
        "name": "Abonnements push",
        "description": "Abonnements navigateur pour les notifications « nouveau brief ».",
        "fields": [
            text("Identifiant"),
            long("Endpoint"),
            text("Clé p256dh"),
            text("Clé auth"),
            text("Appareil"),
            check("Active"),
            datetime_("Créé le"),
            datetime_("Dernière notification"),
        ],
        "links": [("Client", "Clients")],
    })

    spec.append({
        "name": "Journal",
        "description": "Traçabilité des connexions, recherches et lectures.",
        "fields": [
            text("Événement"),
            select("Type", [
                "Connexion", "Échec connexion", "Lecture", "Recherche",
                "Notification", "Déconnexion",
            ]),
            text("Jeton saisi"),
            text("Détail"),
            datetime_("Horodatage"),
            text("Appareil"),
        ],
        "links": [("Client", "Clients")],
    })

    return spec, ids


# --------------------------------------------------------------------------- #
# Exécution
# --------------------------------------------------------------------------- #


def ensure_tables():
    existing = schema()
    by_name = {t["name"]: t for t in existing}

    # 1. Recycler la table par défaut "Table 1" en table de réglages
    if "Table 1" in by_name and "Réglages" not in by_name:
        t = by_name["Table 1"]
        call("PATCH", f"/meta/bases/{BASE_ID}/tables/{t['id']}", {
            "name": "Réglages",
            "description": "Paramètres de l'application (clé / valeur), lus au démarrage.",
        })
        primary = t["fields"][0]
        if primary["name"] != "Clé":
            call(
                "PATCH",
                f"/meta/bases/{BASE_ID}/tables/{t['id']}/fields/{primary['id']}",
                {"name": "Clé"},
            )
        for f in [long("Valeur"), text("Description")]:
            call("POST", f"/meta/bases/{BASE_ID}/tables/{t['id']}/fields", f)
        print("  ~ Table 1 -> Réglages")
        existing = schema()
        by_name = {t["name"]: t for t in existing}

    spec, _ = tables_spec(existing)

    # 2. Créer les tables manquantes / compléter les champs manquants
    for s in spec:
        if s["name"] not in by_name:
            created = call("POST", f"/meta/bases/{BASE_ID}/tables", {
                "name": s["name"],
                "description": s["description"],
                "fields": s["fields"],
            })
            print(f"  + table {s['name']} ({len(s['fields'])} champs)")
            by_name[s["name"]] = created
        else:
            tid = by_name[s["name"]]["id"]
            have = {f["name"] for f in by_name[s["name"]]["fields"]}
            for f in s["fields"]:
                if f["name"] not in have:
                    call("POST", f"/meta/bases/{BASE_ID}/tables/{tid}/fields", f)
                    print(f"  + champ {s['name']}.{f['name']}")

    # 3. Deuxième passe : les champs de liaison (nécessitent les ID de tables)
    existing = schema()
    by_name = {t["name"]: t for t in existing}
    for s in spec:
        for field_name, target in s.get("links", []):
            t = by_name[s["name"]]
            have = {f["name"] for f in t["fields"]}
            if field_name in have:
                continue
            call(
                "POST",
                f"/meta/bases/{BASE_ID}/tables/{t['id']}/fields",
                link(field_name, by_name[target]["id"]),
            )
            print(f"  + lien {s['name']}.{field_name} -> {target}")

    return schema()


if __name__ == "__main__":
    print(f"Base {BASE_ID}")
    final = ensure_tables()
    print("\n=== Schéma final ===")
    for t in final:
        print(f"\n{t['name']}  [{t['id']}]")
        for f in t["fields"]:
            print(f"   - {f['name']:<26} {f['type']}")
    ids = {t["name"]: t["id"] for t in final}
    print("\nIDs :", json.dumps(ids, ensure_ascii=False))
