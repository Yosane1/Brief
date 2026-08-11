#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Rend le résumé des dépêches demandées, et rien d'autre.

Étape 2 du pipeline nocturne. `veille.jsonl` ne porte que les titres : de quoi
choisir les sujets, pas de quoi les écrire. Une fois la sélection faite, ce
script sort le résumé complet des dépêches retenues.

Charger les 188 résumés d'avance pour en utiliser une trentaine dépensait la
moitié du contexte de la session en pure perte — et ce contexte est renvoyé au
modèle à chaque appel d'outil.

Sois large dans la demande : mieux vaut soixante résumés lus qu'un article
écrit sur la foi d'un titre. Un résumé pèse environ 250 octets, un article
approximatif se paie en crédibilité.

Usage :
    python scripts/depeches.py lm001 fi017 bbc003
    python scripts/depeches.py lm001,fi017,bbc003
    python scripts/depeches.py --jour 2026-08-11 lm001
"""
import argparse
import json
import sys
from pathlib import Path

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")


def charger(jour=None, dossier="veille"):
    """
    Le fichier du jour demandé, ou le plus récent du dossier.

    Sans `--jour`, on prend le dernier : les noms sont des dates, le tri
    alphabétique suffit. C'est le cas normal — la routine tourne le soir même
    de la collecte et n'a aucune date à calculer.
    """
    base = Path(dossier)
    if jour:
        chemins = [base / f"{jour}.json"]
    else:
        chemins = sorted(base.glob("*.json"))[-1:]
    if not chemins or not chemins[0].exists():
        cible = f"{dossier}/{jour}.json" if jour else f"{dossier}/"
        sys.exit(f"✗ Aucune collecte trouvée dans {cible} — "
                 f"le workflow de collecte a-t-il tourné ?")
    return json.loads(chemins[0].read_text(encoding="utf-8")), chemins[0]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="+", help="identifiants, séparés par des espaces ou des virgules")
    ap.add_argument("--jour", help="date de la collecte (défaut : la plus récente)")
    ap.add_argument("--dossier", default="veille")
    a = ap.parse_args()

    demandes, vus = [], set()
    for brut in a.ids:
        for i in brut.replace(",", " ").split():
            if i not in vus:            # un doublon coûterait un résumé pour rien
                vus.add(i)
                demandes.append(i)

    detail, chemin = charger(a.jour, a.dossier)

    introuvables = []
    for i in demandes:
        entree = detail.get(i)
        if not entree:
            introuvables.append(i)
            continue
        # [source, titre, url, résumé] — seul le résumé manque à l'appelant.
        resume = entree[3] if len(entree) > 3 else ""
        print(json.dumps({"id": i, "resume": resume},
                         ensure_ascii=False, separators=(",", ":")))

    if introuvables:
        print(f"⚠ {len(introuvables)} identifiant(s) absent(s) de {chemin} : "
              f"{', '.join(introuvables)}", file=sys.stderr)
    print(f"{len(demandes) - len(introuvables)} résumé(s) sur {len(detail)} dépêches.",
          file=sys.stderr)
