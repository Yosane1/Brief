#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Publie une édition dans Airtable à partir d'un fichier JSON.

Étape 3 du pipeline nocturne. L'opération est un *upsert* : relancer le script
sur la même date remplace proprement l'édition et ses articles, sans doublon.

Claude ne cite pas les URL : il écrit des identifiants de dépêche (« lm042 »),
que ce script détend en « source — titre | url » depuis veille/. Les URL
complètes ne traversent donc jamais son contexte. Voir fetch_news.py.

Usage :
    python scripts/push_edition.py editions/2026/2026-08-11.json
    python scripts/push_edition.py editions/2026/2026-08-11.json --brouillon

Format attendu : voir editions/_modele.json
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# La console Windows est en cp1252 : sans ça, un simple « é » fait planter le script.
for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from airtable import select, create, update, delete, esc  # noqa: E402

CHAMPS_EDITION = {
    "titre": "Titre", "date": "Date", "numero": "Numéro", "type": "Type",
    "statut": "Statut", "edito": "Édito", "resume": "Résumé",
    "temps_lecture": "Temps de lecture", "image": "Image de une",
    "credit_image": "Crédit image", "genere_par": "Généré par", "slug": "Slug",
}

CHAMPS_ARTICLE = {
    "titre": "Titre", "rubrique": "Rubrique", "thematique": "Thématique",
    "ordre": "Ordre", "chapo": "Chapô", "contenu": "Contenu",
    "chiffre": "Chiffre clé", "legende_chiffre": "Légende chiffre",
    "citation": "Citation", "auteur_citation": "Auteur citation",
    "image": "Image", "legende_image": "Légende image", "sources": "Sources",
    "mots_cles": "Mots-clés", "date": "Date", "a_la_une": "À la une",
    "temps_lecture": "Temps de lecture",
}


# Un préfixe de source peut contenir des chiffres — « f24 » pour France 24 —
# d'où la première lettre isolée. Ce motif ne sert qu'à distinguer un
# identifiant introuvable d'une source écrite à la main : la résolution, elle,
# se fait par recherche dans la table.
ID_DEPECHE = re.compile(r"^[a-z][a-z0-9]{1,3}\d{3}$")


def mappe(source, table):
    return {v: source[k] for k, v in table.items() if source.get(k) not in (None, "")}


def charger_liens(jour, dossier="veille"):
    """
    Table « identifiant de dépêche → source — titre | url ».

    On cherche d'abord le fichier du jour, celui que la collecte a déposé
    quarante minutes avant la rédaction. S'il manque — édition republiée des
    mois plus tard, date décalée d'un jour — on relit tout le dossier plutôt
    que d'abandonner : ces fichiers ne sont jamais écrasés, l'identifiant s'y
    trouve forcément.
    """
    base = Path(dossier)
    direct = base / f"{jour}.json"
    fichiers = [direct] if direct.exists() else sorted(base.glob("*.json"))

    table = {}
    for f in fichiers:
        try:
            brut = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"  ⚠ {f} illisible ({e}) — ignoré")
            continue
        for cle, valeur in brut.items():
            source, titre, url = (list(valeur) + ["", "", ""])[:3]
            table[cle] = f"{source} — {titre} | {url}"
    return table


def resoudre_sources(sources, liens, titre_article):
    """
    Détend les identifiants ; laisse passer tout le reste inchangé.

    Une édition écrite à la main, ou reprise d'avant ce format, cite ses URL
    directement — elle doit continuer de fonctionner.
    """
    lignes, manquants = [], []
    for s in sources:
        if isinstance(s, dict):            # {"titre": …, "url": …}
            lignes.append(f"{s.get('titre', '')} | {s.get('url', '')}")
            continue
        s = str(s).strip()
        if s in liens:                     # la table tranche, pas le motif
            lignes.append(liens[s])
            continue
        if ID_DEPECHE.match(s):            # gardé tel quel : mieux vaut une
            manquants.append(s)            # trace qu'une source effacée
        lignes.append(s)
    if manquants:
        print(f"  ⚠ « {titre_article[:45]} » : {', '.join(manquants)} "
              f"introuvable(s) dans veille/")
    return "\n".join(lignes)


def numero_suivant():
    derniers = select("editions", fields=["Numéro"],
                      sort=[("Numéro", "desc")], max_records=1)
    if derniers and derniers[0]["fields"].get("Numéro"):
        return int(derniers[0]["fields"]["Numéro"]) + 1
    return 1


def publier(chemin, brouillon=False):
    with open(chemin, encoding="utf-8") as f:
        data = json.load(f)

    ed = data["edition"]
    articles = data.get("articles", [])
    slug = ed.get("slug") or ed["date"]
    ed["slug"] = slug
    ed.setdefault("type", "Quotidienne")
    ed.setdefault("genere_par", "Claude Code Cloud")
    ed["statut"] = "Brouillon" if brouillon else ed.get("statut", "Publiée")
    if not ed.get("temps_lecture"):
        mots = sum(len((a.get("contenu", "") + a.get("chapo", "")).split())
                   for a in articles)
        ed["temps_lecture"] = max(2, round(mots / 220))

    champs = mappe(ed, CHAMPS_EDITION)

    # --- Upsert de l'édition -------------------------------------------------
    existantes = select("editions", formula=f"{{Slug}} = '{esc(slug)}'")
    if existantes:
        rec_id = existantes[0]["id"]
        champs.pop("Numéro", None)  # on ne renumérote pas une édition existante
        update("editions", [{"id": rec_id, "fields": champs}])
        action = "mise à jour"
        # DATESTR() : comparer un champ date à une chaîne avec « = » ne
        # renvoie jamais rien côté Airtable.
        anciens = select("articles", formula=f"DATESTR({{Date}}) = '{esc(ed['date'])}'",
                         fields=["Titre"])
        if anciens:
            delete("articles", [a["id"] for a in anciens])
            print(f"  - {len(anciens)} article(s) remplacé(s)")
    else:
        champs.setdefault("Numéro", numero_suivant())
        if ed["statut"] == "Publiée":
            champs["Publiée le"] = datetime.now(timezone.utc).isoformat()
        rec_id = create("editions", [champs])[0]["id"]
        action = "créée"

    # --- Articles ------------------------------------------------------------
    liens = charger_liens(ed["date"])
    lignes = []
    for i, a in enumerate(articles):
        a.setdefault("ordre", i + 1)
        a.setdefault("date", ed["date"])
        if isinstance(a.get("sources"), list):
            a["sources"] = resoudre_sources(a["sources"], liens, a.get("titre", ""))
        if isinstance(a.get("mots_cles"), list):
            a["mots_cles"] = ", ".join(a["mots_cles"])
        ligne = mappe(a, CHAMPS_ARTICLE)
        ligne["Édition"] = [rec_id]
        lignes.append(ligne)

    if lignes:
        create("articles", lignes)

    print(f"✓ Édition {slug} {action} — {len(lignes)} article(s), "
          f"statut « {ed['statut']} », {champs.get('Temps de lecture', '?')} min de lecture")
    return rec_id


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("fichier", nargs="+")
    ap.add_argument("--brouillon", action="store_true",
                    help="publier en brouillon (invisible dans l'app)")
    a = ap.parse_args()
    for f in a.fichier:
        publier(f, a.brouillon)
