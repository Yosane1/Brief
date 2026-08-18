#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
La forme des identifiants de dépêche, et leur résolution.

Un identifiant désigne une dépêche *dans une collecte*, jamais dans l'absolu :
les numéros repartent à 001 chaque soir. Les 189 identifiants du 11 août 2026
existaient tous le 12, en désignant d'autres dépêches. Tant qu'ils ne portaient
pas leur date, deux erreurs restaient indétectables :

  • résoudre une édition contre la veille d'un autre jour donnait des sources
    parfaitement formées et entièrement fausses ;
  • fusionner plusieurs collectes — ce que `charger_liens` fait quand le fichier
    du jour manque — écrasait chaque identifiant par son homonyme le plus
    récent, en silence.

D'où le préfixe `MMJJ-` : `0815-lm001` est la première dépêche du Monde
collectée le 15 août. La date se relit d'un coup d'œil et se recoupe avec celle
de l'édition.

Ce que le préfixe ne corrige pas, et il faut le savoir : recopier `0815-lm003`
au lieu de `0815-lm001` reste aussi facile qu'avant. Contre ce glissement-là,
seul le contrôle de cohérence de `verifier_edition.py` peut quelque chose.

Le mois et le jour suffisent : le dossier `veille/` couvre des mois, jamais des
années. Une édition republiée plus d'un an après sa parution retomberait sur un
homonyme — cas assez théorique pour qu'on s'en tienne à quatre chiffres plutôt
que d'alourdir chaque citation de trois caractères de plus, que le modèle aurait
à recopier sans faute.
"""
import re
import unicodedata

# `lm001` comme `0815-lm001` : les éditions écrites avant le préfixe citent la
# forme nue, et elles doivent continuer de se republier à l'identique.
MOTIF = re.compile(r"^(?:\d{4}-)?[a-z][a-z0-9]{1,3}\d{3}$")


def prefixe(jour):
    """« 2026-08-15 » → « 0815 ». Chaîne vide si la date est inexploitable."""
    return f"{jour[5:7]}{jour[8:10]}" if jour and len(jour) >= 10 else ""


def denuder(ident):
    """Retire le préfixe de date s'il y en a un."""
    return ident.split("-", 1)[1] if "-" in ident else ident


def indexer(detail, jour, table=None, ambigus=None):
    """
    Range une collecte dans une table qui accepte les deux formes.

    Chaque dépêche y entre sous sa clé de fichier, sous sa forme nue et sous sa
    forme datée : un identifiant cité de l'une ou l'autre façon aboutit.

    `ambigus` recueille les formes nues qu'une seconde collecte revendique déjà.
    Elles sont alors retirées de la table plutôt que tranchées au hasard — c'est
    exactement le silence qu'on cherche à faire cesser. Les formes datées, elles,
    ne se marchent jamais dessus : c'est tout l'intérêt du préfixe.
    """
    table = {} if table is None else table
    ambigus = set() if ambigus is None else ambigus
    date = prefixe(jour)

    for cle, valeur in detail.items():
        nu = denuder(cle)
        for forme in {cle, nu, f"{date}-{nu}" if date else nu}:
            # Une forme déjà disputée le reste : sans ce garde, une troisième
            # collecte la réintroduirait, la table ne la contenant plus.
            if forme in ambigus:
                continue
            if forme in table and table[forme] != valeur:
                # Deux collectes se disputent la même forme : personne ne gagne.
                ambigus.add(forme)
            else:
                table.setdefault(forme, valeur)

    for forme in ambigus:
        table.pop(forme, None)
    return table, ambigus


# ── Cohérence entre un article et la dépêche qu'il cite ────────────────────

# Mots outils du français : présents partout, ils ne rapprochent rien.
VIDES = frozenset((
    "dans pour avec sans sous plus tout tous toute toutes cette leur leurs elle "
    "mais donc alors comment pourquoi entre apres avant chez vers contre depuis "
    "encore aussi celui ceux cela quand faire fait etre avoir vont sont ont les "
    "des une aux qui que quoi dont ses son sur par est ete moins tres bien deja "
    "ainsi cet ces nous vous ils elles leur dont voici voila selon apres"
).split())


def mots(texte):
    """
    Les mots d'un texte qui portent du sens : au moins quatre lettres, accents
    neutralisés pour que « éclipse » et « Eclipse » se rejoignent.
    """
    t = unicodedata.normalize("NFD", str(texte or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return {m for m in re.split(r"[^a-z0-9]+", t) if len(m) >= 4 and m not in VIDES}


def concorde(vocabulaire_article, titre_depeche):
    """
    Vrai si la dépêche partage au moins un mot significatif avec l'article.

    C'est volontairement le test le plus permissif qui soit : il ne juge pas de
    la pertinence d'une source, il repère celle qui n'a rien à voir. Mesuré sur
    les éditions des 12 et 13 août 2026 — 49 citations — il n'a levé qu'une
    seule fausse alerte. Un seuil plus exigeant en produirait bien davantage.
    """
    return bool(vocabulaire_article & mots(titre_depeche))


# ── La citation : un identifiant, et l'amorce du titre qu'il désigne ───────
#
# Un identifiant nu est un numéro sans redondance : `lm003` recopié pour
# `lm001` se résout parfaitement, sur une autre dépêche, et rien ne peut le
# voir. Le contrôle par recouvrement de vocabulaire (`concorde`) est le seul
# filet possible dans ce cas, et il est grossier — il ne repère que la source
# qui n'a *rien* à voir, jamais la voisine plausible.
#
# D'où la citation en deux parties :
#
#     0818-lm001 · La chaîne ABC poursuit l'administration Trump
#
# Les deux moitiés désignent la même dépêche par deux chemins indépendants.
# Elles concordent, la source est prouvée ; elles divergent, on sait qu'il y a
# faute — et le titre, lui, dit laquelle. L'erreur passe ainsi de silencieuse à
# réparable. C'est la seule propriété qui compte : un identifiant faux échoue
# désormais bruyamment au lieu de désigner autre chose.

SEPARATEURS = "·—–|"

# Part des mots du fragment qu'on doit retrouver dans le titre cité pour
# considérer que les deux moitiés parlent de la même dépêche. Un fragment
# recopié fidèlement marque 1,0 ; deux dépêches voisines du même média sur des
# sujets différents tombent près de 0.
SEUIL_ACCORD = 0.6

# Pour *corriger* on exige davantage que pour valider : on s'apprête à changer
# la source citée, pas seulement à la laisser passer.
SEUIL_CORRECTION = 0.7
SEUIL_LARGE = 0.85

# Deux dépêches à moins de ça l'une de l'autre, c'est une égalité : on renonce
# plutôt que de trancher au hasard — ce serait reproduire le défaut traité.
ECART_MINIMAL = 0.15

# En dessous de trois mots pleins, un fragment ne prouve rien : « La chaîne
# ABC » se retrouve dans n'importe quoi. On retombe alors sur l'ancien contrôle.
MOTS_SUFFISANTS = 3


def decouper(citation):
    """
    « 0818-lm001 · La chaîne ABC poursuit… » → (« 0818-lm001 », « La chaîne… »).

    Rend `(None, "")` pour tout ce qui n'est pas une citation d'identifiant :
    une URL, un titre libre, une ligne déjà résolue. Ces formes traversent le
    pipeline sans qu'on y touche — une édition ancienne doit se republier telle
    quelle. Une ligne résolue commence par le nom du média, qui ne peut pas
    passer pour un identifiant : le motif tranche sans ambiguïté.
    """
    texte = str(citation or "").strip()
    tete, reste = texte, ""
    for i, c in enumerate(texte):
        if c in SEPARATEURS:
            tete, reste = texte[:i].strip(), texte[i + 1:].strip()
            break
    return (tete, reste) if MOTIF.match(tete) else (None, "")


def recouvrement(fragment, titre):
    """Part des mots significatifs du fragment qu'on retrouve dans le titre."""
    amorce = mots(fragment)
    return len(amorce & mots(titre)) / len(amorce) if amorce else 0.0


def verifiable(fragment):
    """Vrai si le fragment porte assez de matière pour prouver quoi que ce soit."""
    return len(mots(fragment)) >= MOTS_SUFFISANTS


def _meilleur(fragment, lot, seuil):
    notes = sorted(((recouvrement(fragment, e["titre"]), e) for e in lot),
                   key=lambda t: t[0], reverse=True)
    if not notes or notes[0][0] < seuil:
        return None
    if len(notes) > 1 and notes[0][0] - notes[1][0] < ECART_MINIMAL:
        return None
    return notes[0][1]


def corriger(ident, fragment, catalogue):
    """
    Retrouve la dépêche dont le titre correspond au fragment cité.

    L'erreur observée est toujours la même : le bon média, le mauvais numéro.
    Le code de média est alphabétique et porte du sens, il se recopie juste ;
    c'est le rang qui glisse. On cherche donc d'abord chez le même média, où le
    titre suffit largement à trancher, puis on élargit au jour entier en
    exigeant davantage — deux médias couvrant le même événement écrivent des
    titres proches, et là le doute est réel.
    """
    if not verifiable(fragment):
        return None
    code = denuder(ident)[:-3]
    memes = [e for e in catalogue if e["code"] == code]
    return (_meilleur(fragment, memes, SEUIL_CORRECTION)
            or _meilleur(fragment, catalogue, SEUIL_LARGE))


def cataloguer(detail):
    """
    La collecte remise à plat, pour chercher une dépêche par son titre.

    `indexer` produit une table à plusieurs clés par dépêche, faite pour
    résoudre ; celle-ci en produit une liste sans doublon, faite pour comparer.
    """
    lot = []
    for cle, valeur in detail.items():
        source, titre, url = (list(valeur) + ["", "", ""])[:3]
        nu = denuder(cle)
        lot.append({"id": cle, "code": nu[:-3], "titre": titre,
                    "ligne": f"{source} · {titre} | {url}"})
    return lot
