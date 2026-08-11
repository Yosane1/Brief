#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Collecte les dépêches du jour depuis une sélection de flux RSS.

Étape 1 du pipeline nocturne : ce script ne fait *que* récolter de la matière
brute. C'est Claude qui la lit ensuite pour écrire le brief.

Usage :
    python scripts/fetch_news.py                  # dépêches des dernières 24 h
    python scripts/fetch_news.py --hours 48
    python scripts/fetch_news.py --out veille.json
"""
import argparse
import html
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

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


def collect(hours):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    seen, items = set(), []

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
            seen.add(key)
            kept += 1
            items.append({
                "titre": title,
                "resume": field(b, "description", "summary")[:600],
                "lien": field(b, "link", "guid"),
                "source": source,
                "rubrique": rubrique,
                "date": published.isoformat() if published else None,
            })
        print(f"  · {source} / {rubrique} : {kept} dépêches", file=sys.stderr)

    items.sort(key=lambda i: i["date"] or "", reverse=True)
    return items


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--out", default="-")
    a = ap.parse_args()

    print(f"Collecte sur {a.hours} h…", file=sys.stderr)
    data = {
        "collecte": datetime.now(timezone.utc).isoformat(),
        "fenetre_heures": a.hours,
        "depeches": collect(a.hours),
    }
    print(f"\n{len(data['depeches'])} dépêches retenues.", file=sys.stderr)

    payload = json.dumps(data, ensure_ascii=False, indent=1)
    if a.out == "-":
        sys.stdout.write(payload)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"→ {a.out}", file=sys.stderr)
