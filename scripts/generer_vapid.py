#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Génère la paire de clés VAPID qui autorise l'envoi de notifications push.

Le protocole Web Push exige que chaque envoi soit signé par le serveur émetteur,
au moyen d'une clé ECDSA sur la courbe P-256. La clé publique est communiquée au
navigateur au moment de l'abonnement ; la clé privée reste sur le serveur et
signe chaque notification. Sans elle, aucun service de push — Google, Mozilla,
Apple — n'accepte l'envoi.

Cette paire ne se régénère pas à la légère : changer de clé publique invalide
tous les abonnements déjà enregistrés, et les lecteurs devraient réactiver les
notifications un par un.

Usage :
    python scripts/generer_vapid.py
"""
import base64
import json
import subprocess
import sys
import tempfile
import os

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")


def b64url(octets):
    return base64.urlsafe_b64encode(octets).decode().rstrip("=")


def openssl(args, entree=None):
    r = subprocess.run(["openssl"] + args, input=entree,
                       capture_output=True)
    if r.returncode != 0:
        raise SystemExit("openssl a échoué :\n" + r.stderr.decode("utf-8", "replace"))
    return r.stdout


def generer():
    tmp = tempfile.mkdtemp()
    prive = os.path.join(tmp, "vapid.pem")
    try:
        openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout",
                 "-out", prive])

        # Le point public non compressé fait 65 octets et se termine par
        # « 04 || X || Y » : on le récupère à la fin du DER.
        der_pub = openssl(["ec", "-in", prive, "-pubout", "-outform", "DER"])
        point = der_pub[-65:]
        if point[0] != 0x04:
            raise SystemExit("Format de clé publique inattendu.")
        x, y = point[1:33], point[33:65]

        # La clé privée brute fait 32 octets, repérables dans le DER SEC1.
        der_priv = openssl(["ec", "-in", prive, "-outform", "DER"])
        marqueur = b"\x04\x20"
        i = der_priv.find(marqueur, 2)
        if i < 0:
            raise SystemExit("Format de clé privée inattendu.")
        d = der_priv[i + 2: i + 34]
    finally:
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    return {
        "publique": b64url(point),
        "jwk": {
            "kty": "EC", "crv": "P-256",
            "x": b64url(x), "y": b64url(y), "d": b64url(d),
            "key_ops": ["sign"], "ext": True,
        },
    }


if __name__ == "__main__":
    cles = generer()
    print("Paire VAPID générée.\n")
    print("┌─ À déclarer dans Cloudflare (Settings → Variables and Secrets)")
    print("│")
    print("│  Type   Secret")
    print("│  Nom    VAPID_JWK")
    print("│  Valeur (une seule ligne, tout compris)")
    print("│")
    print("   " + json.dumps(cles["jwk"], separators=(",", ":")))
    print()
    print("┌─ À déclarer dans Cloudflare également")
    print("│")
    print("│  Type   Text")
    print("│  Nom    VAPID_PUBLIC")
    print("│  Valeur")
    print("│")
    print("   " + cles["publique"])
    print()
    print("La clé publique est aussi servie par le Worker sur /vapid : "
          "l'application n'a donc rien à embarquer.")
