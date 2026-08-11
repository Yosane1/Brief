#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Collecte les dépêches du jour depuis une sélection de flux RSS.

Étape 1 du pipeline nocturne : ce script ne fait *que* récolter de la matière
brute. C'est Claude qui la lit ensuite pour écrire le brief.

Deux fichiers en sortie, et la séparation est le cœur du script :

    veille.jsonl            ce que Claude lit d'emblée — titres seuls
    veille/AAAA-MM-JJ.json  résumés et URL, servis à la demande

Sur 188 dépêches collectées, une trentaine finit citée. Charger d'avance les
188 résumés et les 188 URL pour en utiliser trente, c'était les trois quarts du
contexte de la session dépensés en pure perte — et ce contexte est renvoyé au
modèle à chaque appel d'outil.

D'où la coupure. `veille.jsonl` porte de quoi *choisir* : identifiant, date,
source, rubrique, titre. Les résumés viennent ensuite, uniquement pour les
dépêches retenues, via `depeches.py` ; les URL ne viennent jamais, c'est
`push_edition.py` qui les résout à la publication depuis le même fichier.

Bénéfice annexe : plus aucune URL ne peut être inventée ou tronquée, puisque
Claude ne cite que des identifiants.

Le fichier du dossier `veille/` n'est jamais écrasé : une édition republiée des
mois plus tard y retrouve ses sources.

Usage :
    python scripts/fetch_news.py                        # dernières 24 h
    python scripts/fetch_news.py --hours 48
    python scripts/fetch_news.py --hours 26 --out veille.jsonl
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

try:
    from zoneinfo import ZoneInfo
    PARIS = ZoneInfo("Europe/Paris")
except Exception:       # tzdata absent : on reste en UTC, l'écart est d'une heure
    PARIS = timezone.utc

FEEDS = [
    ("franceinfo",      "France",        "https://www.francetvinfo.fr/titres.rss"),
    ("Le Monde",        "France",        "https://www.lemonde.fr/rss/une.xml"),
    ("Le Monde",        "International", "https://www.lemonde.fr/international/rss_full.xml"),
    ("Le Monde",        "Économie",      "https://www.lemonde.fr/economie/rss_full.xml"),
    ("Le Monde",        "Sciences",      "https://www.lemonde.fr/sciences/rss_full.xml"),
    ("Le Monde",        "Culture",       "https://www.lemonde.fr/culture/rss_full.xml"),
    ("France 24",       "International", "https://www.france24.com/fr/rss"),
    ("Libération",      "France",        "https://www.liberation.fr/arc/outboundfeeds/rss-all/?outputType=xml"),
    ("BBC News",        "International", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("Futura Sciences", "Sciences",      "https://www.futura-sciences.com/rss/actualites.xml"),
    ("Novethic",        "Environnement", "https://www.novethic.fr/rss.xml"),
]

# Préfixe d'identifiant par source. Court et stable : il finit recopié par
# Claude dans le champ `sources` de chaque article.
CODES = {
    "franceinfo": "fi", "Le Monde": "lm", "France 24": "f24",
    "Libération": "lib", "BBC News": "bbc", "Futura Sciences": "fs",
    "Novethic": "nov",
}

# Matière que l'étape 2 du brief écarte de toute façon : autant ne pas la faire
# lire. Le filtre est volontairement étroit. Un motif trop large — « /live/ »,
# « en direct » — emporte de vraies actualités (une canicule, une guerre), et
# une dépêche perdue ne se voit nulle part dans le compte rendu du soir. Tout
# rejet est journalisé pour rester vérifiable.
EXCLUS_URL = ("podcasts.", "/podcast", "/bons-plans", "/jeux-concours")
EXCLUS_TITRE = re.compile(
    r"bons? plans?|prix cassé|meilleur prix|à ne pas manquer|soldes"
    r"|à moins de \d+\s?€|\d{1,2}\s?% de son prix",
    re.I,
)

TAG = re.compile(r"<[^>]+>")
CDATA = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S)


def clean(s):
    if not s:
        return ""
    s = CDATA.sub(r"\1", s)
    s = TAG.sub(" ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def field(item, *names):
    for n in names:
        m = re.search(rf"<{n}[^>]*>(.*?)</{n}>", item, re.S | re.I)
        if m:
            return clean(m.group(1))
    return ""


def parse_date(raw):
    if not raw:
        return None
    try:
        d = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def fetch(url):
    out = subprocess.run(
        ["curl", "-sL", "-m", "25", "-A", "Mozilla/5.0 (compatible; BriefBot/1.0)", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    return out.stdout if out.returncode == 0 else ""


def ecarter(titre, lien):
    """Renvoie le motif du rejet, ou None si la dépêche est à garder."""
    if any(m in lien.lower() for m in EXCLUS_URL):
        return "podcast / page commerciale"
    if EXCLUS_TITRE.search(titre):
        return "titre commercial"
    return None


def collect(hours):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    tres_vieux = datetime.min.replace(tzinfo=timezone.utc)
    seen, items, ecartes = set(), [], []

    for source, rubrique, url in FEEDS:
        xml = fetch(url)
        if not xml:
            print(f"  ! flux injoignable : {source} / {rubrique}", file=sys.stderr)
            continue
        blocks = re.findall(r"<item[^>]*>(.*?)</item>", xml, re.S | re.I)
        if not blocks:  # Atom
            blocks = re.findall(r"<entry[^>]*>(.*?)</entry>", xml, re.S | re.I)
        kept = 0
        for b in blocks:
            title = field(b, "title")
            if not title:
                continue
            key = re.sub(r"[^a-z0-9]", "", title.lower())[:60]
            if key in seen:
                continue
            published = parse_date(field(b, "pubDate", "published", "updated", "dc:date"))
            if published and published < cutoff:
                continue
            lien = field(b, "link", "guid")
            motif = ecarter(title, lien)
            if motif:
                ecartes.append((motif, source, title))
                continue
            seen.add(key)
            kept += 1
            items.append({
                "titre": title,
                "resume": field(b, "description", "summary")[:600],
                "lien": lien,
                "source": source,
                "rubrique": rubrique,
                "date": published,
            })
        print(f"  · {source} / {rubrique} : {kept} dépêches", file=sys.stderr)

    if ecartes:
        print(f"\n  {len(ecartes)} dépêche(s) écartée(s) :", file=sys.stderr)
        for motif, source, titre in ecartes:
            print(f"    – [{motif}] {source} — {titre[:70]}", file=sys.stderr)

    items.sort(key=lambda i: i["date"] or tres_vieux, reverse=True)

    # Identifiants attribués après tri : « lm001 » est la dépêche du Monde la
    # plus récente, ce qui rend le fichier lisible de haut en bas.
    compteurs = {}
    for it in items:
        code = CODES.get(it["source"]) or re.sub(r"[^a-z]", "", it["source"].lower())[:3]
        compteurs[code] = compteurs.get(code, 0) + 1
        it["id"] = f"{code}{compteurs[code]:03d}"

    return items


def ecrire(items, chemin_veille, dossier_liens, heures):
    maintenant = datetime.now(timezone.utc).astimezone(PARIS)
    jour = maintenant.strftime("%Y-%m-%d")
    chemin_liens = os.path.join(dossier_liens, f"{jour}.json").replace(os.sep, "/")

    entete = {
        "collecte": maintenant.strftime("%Y-%m-%d %H:%M"),
        "fuseau": "Europe/Paris",
        "fenetre_heures": heures,
        "depeches": len(items),
        "detail": chemin_liens,
        "format": "titres seuls — résumés via « python scripts/depeches.py id1 id2 … »",
    }

    lignes = [json.dumps(entete, ensure_ascii=False, separators=(",", ":"))]
    detail = {}
    for it in items:
        d = it["date"]
        lignes.append(json.dumps({
            "id": it["id"],
            "date": d.astimezone(PARIS).strftime("%m-%d %H:%M") if d else "",
            "source": it["source"],
            "rubrique": it["rubrique"],
            "titre": it["titre"],
        }, ensure_ascii=False, separators=(",", ":")))
        # Ordre figé : source, titre, url, résumé. push_edition.py ne lit que
        # les trois premiers, depeches.py que le dernier.
        detail[it["id"]] = [it["source"], it["titre"], it["lien"], it["resume"]]

    with open(chemin_veille, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")

    # Un identifiant par ligne : le fichier n'est lu que par une machine, mais
    # ses différences doivent rester relisibles dans git.
    os.makedirs(dossier_liens, exist_ok=True)
    with open(chemin_liens, "w", encoding="utf-8") as f:
        corps = ",\n".join(
            f' {json.dumps(k, ensure_ascii=False)}: '
            f'{json.dumps(v, ensure_ascii=False, separators=(", ", ": "))}'
            for k, v in detail.items()
        )
        f.write("{\n" + corps + "\n}\n")

    return chemin_veille, chemin_liens


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--out", default="veille.jsonl",
                    help="fichier lu par Claude (défaut : veille.jsonl)")
    ap.add_argument("--liens", default="veille",
                    help="dossier des URL, jamais lu par Claude (défaut : veille/)")
    a = ap.parse_args()

    print(f"Collecte sur {a.hours} h…", file=sys.stderr)
    depeches = collect(a.hours)
    print(f"\n{len(depeches)} dépêches retenues.", file=sys.stderr)

    veille, liens = ecrire(depeches, a.out, a.liens, a.hours)
    poids = os.path.getsize(veille)
    print(f"→ {veille} ({poids:,} o)".replace(",", " "), file=sys.stderr)
    print(f"→ {liens}", file=sys.stderr)
