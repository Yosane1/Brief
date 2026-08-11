#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Génère les icônes PNG de l'application, sans dépendance externe.

Le poste de développement n'a pas Pillow, et une icône est le seul format que
le manifeste d'une PWA ne peut pas recevoir en SVG sur Android. On encode donc
le PNG à la main : c'est une centaine de lignes pour un aplat et quatre barres.

Usage :
    python scripts/generer_icones.py            # couleur par défaut
    python scripts/generer_icones.py "#0954c0"  # autre accent
"""
import struct
import sys
import zlib

SORTIE = "icones"
ACCENT = "#ff4a59"
SUPER = 4          # suréchantillonnage, pour des bords lisses


# --------------------------------------------------------------------------- #
# Encodage PNG
# --------------------------------------------------------------------------- #

def png(pixels, largeur, hauteur):
    """pixels : liste de (r, g, b, a) en ligne par ligne."""
    brut = bytearray()
    for y in range(hauteur):
        brut.append(0)                       # filtre « None » pour cette ligne
        for x in range(largeur):
            brut += bytes(pixels[y * largeur + x])

    def morceau(typ, data):
        return (struct.pack(">I", len(data)) + typ + data
                + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + morceau(b"IHDR", struct.pack(">IIBBBBB", largeur, hauteur, 8, 6, 0, 0, 0))
            + morceau(b"IDAT", zlib.compress(bytes(brut), 9))
            + morceau(b"IEND", b""))


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# --------------------------------------------------------------------------- #
# Dessin
# --------------------------------------------------------------------------- #

def rect_arrondi(x, y, w, h, r):
    """Retourne un test d'appartenance à un rectangle à coins arrondis."""
    def dedans(px, py):
        if not (x <= px < x + w and y <= py < y + h):
            return False
        # coins
        for cx, cy in ((x + r, y + r), (x + w - r, y + r),
                       (x + r, y + h - r), (x + w - r, y + h - r)):
            if ((px < x + r or px > x + w - r) and (py < y + r or py > y + h - r)):
                if (px - cx) ** 2 + (py - cy) ** 2 > r * r:
                    continue
                return True
        # zones droites
        if x + r <= px <= x + w - r or y + r <= py <= y + h - r:
            return True
        return False
    return dedans


def dessiner(taille, accent, maskable=False):
    """Aplat coloré + trois barres blanches, évoquant des lignes de texte."""
    n = taille * SUPER
    fond = hex_rgb(accent)
    pix = [(0, 0, 0, 0)] * (n * n)

    if maskable:
        # Pleine page : le masque d'Android rognera lui-même les coins.
        forme = lambda px, py: True                                  # noqa: E731
        marge, echelle = 0.28, 0.44
    else:
        forme = rect_arrondi(0, 0, n, n, n * 0.22)
        marge, echelle = 0.22, 0.56

    # Barres : largeurs décroissantes, comme un paragraphe qui se termine.
    hauteur_barre = n * 0.10
    ecart = n * 0.075
    total = 3 * hauteur_barre + 2 * ecart
    haut = (n - total) / 2
    largeurs = [echelle, echelle * 0.78, echelle * 0.5]
    barres = []
    for i, l in enumerate(largeurs):
        by = haut + i * (hauteur_barre + ecart)
        bw = n * l
        bx = n * marge
        barres.append(rect_arrondi(bx, by, bw, hauteur_barre, hauteur_barre / 2))

    for y in range(n):
        for x in range(n):
            if not forme(x, y):
                continue
            couleur = fond
            for b in barres:
                if b(x, y):
                    couleur = (255, 255, 255)
                    break
            pix[y * n + x] = (*couleur, 255)

    # Réduction : moyenne des blocs SUPER × SUPER
    final = []
    for y in range(taille):
        for x in range(taille):
            r = v = b = a = 0
            for dy in range(SUPER):
                for dx in range(SUPER):
                    p = pix[(y * SUPER + dy) * n + (x * SUPER + dx)]
                    r += p[0] * p[3]; v += p[1] * p[3]; b += p[2] * p[3]; a += p[3]
            if a:
                final.append((r // a, v // a, b // a, a // (SUPER * SUPER)))
            else:
                final.append((0, 0, 0, 0))
    return png(final, taille, taille)


if __name__ == "__main__":
    import os
    accent = sys.argv[1] if len(sys.argv) > 1 else ACCENT
    os.makedirs(SORTIE, exist_ok=True)

    cibles = [
        ("icone-192.png", 192, False),
        ("icone-512.png", 512, False),
        ("icone-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]
    for nom, taille, maskable in cibles:
        chemin = os.path.join(SORTIE, nom)
        with open(chemin, "wb") as f:
            f.write(dessiner(taille, accent, maskable))
        print(f"  + {chemin} ({taille}×{taille}{', maskable' if maskable else ''})")
    print(f"\nIcônes générées en {accent}.")
