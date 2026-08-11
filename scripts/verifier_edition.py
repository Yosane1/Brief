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
import sys
from datetime import date

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from airtable import select, esc  # noqa: E402

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
    for a in articles:
        f = a["fields"]
        r = f.get("Rubrique", "(vide)")
        par_rubrique.setdefault(r, 0)
        par_rubrique[r] += 1

        titre = (f.get("Titre") or "(sans titre)")[:60]
        if not f.get("Titre"):
            alertes.append(f"article sans titre ({a['id']})")
        if not f.get("Contenu"):
            alertes.append(f"« {titre} » : contenu vide")
        if not f.get("Chapô"):
            avertissements.append(f"« {titre} » : pas de chapô")
        if not f.get("Sources"):
            avertissements.append(f"« {titre} » : aucune source")
        if not f.get("Mots-clés"):
            avertissements.append(f"« {titre} » : aucun mot-clé (invisible en recherche)")
        if r not in RUBRIQUES_CONNUES:
            alertes.append(f"« {titre} » : rubrique inconnue « {r} »")
        if not f.get("Édition"):
            avertissements.append(f"« {titre} » : non relié à l'édition")

    print("\n  Répartition :")
    for r, n in sorted(par_rubrique.items(), key=lambda x: -x[1]):
        print(f"    {n:>2} × {r}")

    # L'extra du samedi n'a pas de décryptage : c'est son format.
    if ed.get("Type") != "Extra du samedi" and "Tout s'explique" not in par_rubrique:
        avertissements.append("pas de décryptage « Tout s'explique »")

    minutes = ed.get("Temps de lecture") or 0
    if minutes > 9:
        avertissements.append(
            f"{minutes} min de lecture : au-dessus de la promesse « moins de 7 minutes », "
            f"envisager de retirer {max(1, (minutes - 7) * 2)} article(s)"
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
