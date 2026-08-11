#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Relit une édition depuis Airtable et signale ce qui clocherait à l'affichage.

Étape 4 du pipeline nocturne : c'est le garde-fou. Il lit ce que l'application
lira réellement, avec la même requête, et sort en code 1 si l'édition est
inexploitable.

Usage :
    python scripts/verifier_edition.py              # la dernière publiée
    python scripts/verifier_edition.py 2026-08-11
"""
import re
import sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from airtable import select, esc  # noqa: E402

# Un identifiant de dépêche qui a survécu jusqu'à Airtable, c'est une source
# que push_edition.py n'a pas su détendre : le lecteur verrait « lm042 ».
ID_NON_RESOLU = re.compile(r"^[a-z][a-z0-9]{1,3}\d{3}$")

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

RUBRIQUES_CONNUES = {
    "On rembobine", "Tout s'explique", "On fait le point", "C'est leur avis",
    "Ça se voit", "C'est qui ?", "Ça alors", "Ça peut servir", "Ça vaut un clic",
    "À vous de jouer", "On revient au début", "On rembobine la semaine",
    "C'est quoi ?",
}


def verifier(jour=None):
    editions = select(
        "editions",
        formula=f"{{Slug}} = '{esc(jour)}'" if jour else "{Statut} = 'Publiée'",
        sort=[("Date", "desc")],
        max_records=1 if not jour else None,
    )
    if not editions:
        print(f"✗ Aucune édition trouvée pour « {jour or 'la dernière publiée'} ».")
        return 1

    ed = editions[0]["fields"]
    slug = ed.get("Slug") or ed.get("Date")
    # Même requête que l'application : DATESTR est obligatoire sur un champ date.
    articles = select(
        "articles",
        formula=f"DATESTR({{Date}}) = '{esc(ed.get('Date'))}'",
        sort=[("Ordre", "asc")],
    )

    alertes, avertissements = [], []

    print(f"Édition {slug} — « {ed.get('Titre', '(sans titre)')} »")
    print(f"  statut       : {ed.get('Statut')}")
    print(f"  type         : {ed.get('Type')}")
    print(f"  numéro       : {ed.get('Numéro', '—')}")
    print(f"  lecture      : {ed.get('Temps de lecture', '—')} min")
    print(f"  articles     : {len(articles)}")

    if ed.get("Statut") != "Publiée":
        avertissements.append(f"statut « {ed.get('Statut')} » : invisible dans l'app")
    if not ed.get("Résumé"):
        avertissements.append("pas de résumé (utilisé comme texte de notification)")
    if not ed.get("Édito"):
        avertissements.append("pas d'édito")
    if not articles:
        alertes.append("aucun article rattaché : l'édition s'affichera vide")

    par_rubrique = {}
    mobilier = {"chiffre": 0, "citation": 0, "à la une": 0}
    for a in articles:
        f = a["fields"]
        r = f.get("Rubrique", "(vide)")
        par_rubrique.setdefault(r, 0)
        par_rubrique[r] += 1
        if f.get("Chiffre clé"):
            mobilier["chiffre"] += 1
        if f.get("Citation"):
            mobilier["citation"] += 1
        if f.get("À la une"):
            mobilier["à la une"] += 1

        titre = (f.get("Titre") or "(sans titre)")[:60]
        if not f.get("Titre"):
            alertes.append(f"article sans titre ({a['id']})")
        if not f.get("Contenu"):
            alertes.append(f"« {titre} » : contenu vide")
        if not f.get("Chapô"):
            avertissements.append(f"« {titre} » : pas de chapô")
        if not f.get("Sources"):
            avertissements.append(f"« {titre} » : aucune source")
        else:
            bruts = [l for l in f["Sources"].splitlines() if ID_NON_RESOLU.match(l.strip())]
            if bruts:
                alertes.append(f"« {titre} » : source(s) non résolue(s) "
                               f"{', '.join(bruts)} — dépêche absente de veille/")
        if not f.get("Mots-clés"):
            avertissements.append(f"« {titre} » : aucun mot-clé (invisible en recherche)")
        if r not in RUBRIQUES_CONNUES:
            alertes.append(f"« {titre} » : rubrique inconnue « {r} »")
        if not f.get("Édition"):
            avertissements.append(f"« {titre} » : non relié à l'édition")

    print("\n  Répartition :")
    for r, n in sorted(par_rubrique.items(), key=lambda x: -x[1]):
        print(f"    {n:>2} × {r}")
    print("  Rythme       : "
          + ", ".join(f"{n} {nom}" for nom, n in mobilier.items()))

    # L'extra du samedi n'a pas de décryptage : c'est son format.
    extra = ed.get("Type") == "Extra du samedi"
    if not extra and "Tout s'explique" not in par_rubrique:
        avertissements.append("pas de décryptage « Tout s'explique »")

    # Sans chiffre ni citation, la page est une suite de blocs identiques : ce
    # sont eux qui lui donnent son rythme. Le champ « À la une » commande en
    # plus le bloc de tête de l'application — vide, l'édition s'ouvre sans
    # hiérarchie.
    if not extra:
        if not mobilier["chiffre"]:
            avertissements.append("aucun chiffre clé : la page n'a aucun point d'accroche")
        if not mobilier["citation"]:
            avertissements.append("aucune citation")
        if not mobilier["à la une"]:
            alertes.append("aucun article « À la une » : l'édition s'ouvrira sans bloc de tête")
        elif mobilier["à la une"] > 4:
            avertissements.append(
                f"{mobilier['à la une']} articles « À la une » : "
                f"au-delà de trois, ce n'est plus une sélection"
            )

    if not extra and not 9 <= len(articles) <= 11:
        avertissements.append(
            f"{len(articles)} articles : le format en demande 9 à 11"
        )

    minutes = ed.get("Temps de lecture") or 0
    if minutes > 7:
        avertissements.append(
            f"{minutes} min de lecture : au-dessus de la promesse « moins de 7 minutes », "
            f"envisager de retirer {max(1, (minutes - 6) * 2)} article(s)"
        )

    if avertissements:
        print(f"\n  ⚠ {len(avertissements)} avertissement(s) :")
        for a in avertissements[:15]:
            print(f"    · {a}")
        if len(avertissements) > 15:
            print(f"    · … et {len(avertissements) - 15} autre(s)")

    if alertes:
        print(f"\n  ✗ {len(alertes)} problème(s) bloquant(s) :")
        for a in alertes:
            print(f"    · {a}")
        return 1

    print("\n✓ Édition conforme, lisible dans l'application.")
    return 0


if __name__ == "__main__":
    sys.exit(verifier(sys.argv[1] if len(sys.argv) > 1 else None))
