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
import sys
from datetime import datetime, timezone
from pathlib import Path

# La console Windows est en cp1252 : sans ça, un simple « é » fait planter le script.
for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from airtable import select, create, update, delete, esc  # noqa: E402
from identifiants import (SEUIL_ACCORD, cataloguer, concorde, corriger,  # noqa: E402
                          decouper, indexer, mots, recouvrement, verifiable)

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
    # « Mots-clés » ne figure pas ici : Airtable le génère lui-même après la
    # création de l'article. Un champ IA n'est pas inscriptible, et la routine
    # n'a plus à produire ce que la base produit mieux — plus thématique, donc
    # plus utile au nuage d'Explorer, qui vit de ce qui se répète.
    "date": "Date", "a_la_une": "À la une",
    "temps_lecture": "Temps de lecture",
}


def mappe(source, table):
    return {v: source[k] for k, v in table.items() if source.get(k) not in (None, "")}


def charger_liens(jour, dossier="veille"):
    """
    Table « identifiant de dépêche → [source, titre, url] ».

    On cherche d'abord le fichier du jour, celui que la collecte a déposé
    quarante minutes avant la rédaction. S'il manque — édition republiée des
    mois plus tard, date décalée d'un jour — on relit tout le dossier plutôt
    que d'abandonner.

    Ce repli était un piège tant que les identifiants n'étaient pas datés : les
    numéros repartant à 001 chaque soir, les 189 identifiants du 11 août
    existaient tous le 12 en désignant d'autres dépêches, et la fusion les
    écrasait par les plus récents — sans un mot, avec des sources parfaitement
    formées et entièrement fausses. `indexer` écarte désormais toute forme que
    deux collectes se disputent, plutôt que de trancher au hasard.
    """
    base = Path(dossier)
    direct = base / f"{jour}.json"
    fichiers = [direct] if direct.exists() else sorted(base.glob("*.json"))
    if not direct.exists():
        print(f"  ⚠ veille/{jour}.json absent : repli sur {len(fichiers)} collecte(s)")

    table, ambigus, catalogue = {}, set(), []
    for f in fichiers:
        try:
            brut = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"  ⚠ {f} illisible ({e}) — ignoré")
            continue
        indexer(brut, f.stem, table, ambigus)
        catalogue += cataloguer(brut)

    if ambigus:
        apercu = ", ".join(sorted(ambigus)[:5])
        print(f"  ⚠ {len(ambigus)} identifiant(s) revendiqué(s) par plusieurs "
              f"collectes, écarté(s) plutôt que devinés : {apercu}"
              + ("…" if len(ambigus) > 5 else ""))
    return table, catalogue


def ligne_de(entree):
    source, titre, url = (list(entree) + ["", "", ""])[:3]
    return f"{source} · {titre} | {url}"


def resoudre_sources(sources, liens, catalogue, titre_article, vocabulaire=None):
    """
    Détend les citations, et n'écrit que ce qui est vérifié.

    Une source fausse est pire qu'une source absente : elle se lit comme une
    caution. L'article reste parfaitement lisible sans elle, tandis qu'une
    dépêche sans rapport affirme au lecteur quelque chose de faux sur la
    provenance de ce qu'il vient de lire. On écarte donc, on ne se contente
    plus de signaler.

    Trois cas, du plus sûr au plus fragile :

      • citation en deux moitiés — l'identifiant et l'amorce du titre se
        recoupent, la source est prouvée et rien d'autre n'a à être vérifié ;
        ils divergent, on retrouve la dépêche par son titre et on corrige, ou
        on écarte ;
      • citation nue, héritée d'avant ce format — on retombe sur le contrôle
        par vocabulaire, qui ne voit que la source n'ayant aucun rapport ;
      • URL ou ligne déjà résolue — laissée intacte.
    """
    lignes, ecartees, corrigees = [], [], []
    for s in sources:
        if isinstance(s, dict):            # {"titre": …, "url": …}
            lignes.append(f"{s.get('titre', '')} | {s.get('url', '')}")
            continue

        brut = str(s).strip()
        ident, amorce = decouper(brut)
        if not ident:                      # URL, titre libre, ligne résolue
            lignes.append(brut)
            continue

        entree = liens.get(ident)          # la table tranche, pas le motif

        if verifiable(amorce):
            if entree and recouvrement(amorce, entree[1]) >= SEUIL_ACCORD:
                lignes.append(ligne_de(entree))
                continue
            trouve = corriger(ident, amorce, catalogue)
            if trouve:
                lignes.append(trouve["ligne"])
                corrigees.append((ident, trouve["id"], trouve["titre"]))
            else:
                ecartees.append((ident, "le titre cité ne désigne aucune dépêche du jour"))
            continue

        # Citation nue : l'amorce manque ou ne pèse pas assez pour prouver.
        if not entree:
            ecartees.append((ident, "absent de veille/"))
        elif vocabulaire and not concorde(vocabulaire, entree[1]):
            ecartees.append((ident, f"aucun mot commun avec l'article — « {entree[1][:55]} »"))
        else:
            lignes.append(ligne_de(entree))

    for ident, neuf, titre in corrigees:
        print(f"  ↻ « {titre_article[:40]} » : {ident} → {neuf}")
        print(f"      {titre[:70]}")
    for ident, motif in ecartees:
        print(f"  ✂ « {titre_article[:40]} » : {ident} écarté, {motif}")

    return "\n".join(lignes), len(ecartees), len(corrigees)


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
        # `mots` est le nom de la fonction importée d'identifiants.py, dont on
        # se sert plus bas : une variable locale du même nom la masquerait dans
        # toute la fonction, et la publication échouerait au premier article.
        volume = sum(len((a.get("contenu", "") + a.get("chapo", "")).split())
                     for a in articles)
        ed["temps_lecture"] = max(2, round(volume / 220))

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
    liens, catalogue = charger_liens(ed["date"])
    lignes, ecartees, corrigees = [], 0, 0
    for i, a in enumerate(articles):
        a.setdefault("ordre", i + 1)
        a.setdefault("date", ed["date"])
        if isinstance(a.get("sources"), list):
            # Le titre et le chapô suffisent à dire de quoi parle l'article ;
            # le contenu n'ajouterait que du bruit au rapprochement.
            vocabulaire = mots(a.get("titre", "")) | mots(a.get("chapo", ""))
            a["sources"], ecarts, corrections = resoudre_sources(
                a["sources"], liens, catalogue, a.get("titre", ""), vocabulaire)
            ecartees += ecarts
            corrigees += corrections
        a.pop("mots_cles", None)   # toléré dans un JSON ancien, jamais réécrit
        ligne = mappe(a, CHAMPS_ARTICLE)
        ligne["Édition"] = [rec_id]
        lignes.append(ligne)

    if lignes:
        create("articles", lignes)

    print(f"✓ Édition {slug} {action} — {len(lignes)} article(s), "
          f"statut « {ed['statut']} », {champs.get('Temps de lecture', '?')} min de lecture")
    if corrigees:
        print(f"  ↻ {corrigees} source(s) rétablie(s) d'après le titre cité")
    if ecartees:
        # Non publiées : mieux vaut un article sans source qu'un article
        # accompagné d'une dépêche qui parle d'autre chose.
        print(f"  ✂ {ecartees} source(s) écartée(s), faute d'avoir pu être vérifiée(s)")
    return rec_id


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("fichier", nargs="+")
    ap.add_argument("--brouillon", action="store_true",
                    help="publier en brouillon (invisible dans l'app)")
    a = ap.parse_args()
    for f in a.fichier:
        publier(f, a.brouillon)
