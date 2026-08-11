#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Crée les jetons d'accès de démonstration et les réglages de l'application.

Idempotent : relancer le script met à jour les enregistrements existants
plutôt que d'en créer des doublons.

Usage :
    python scripts/seed_acces.py
"""
import sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from airtable import select, create, update, esc  # noqa: E402

for flux in (sys.stdout, sys.stderr):
    if hasattr(flux, "reconfigure"):
        flux.reconfigure(encoding="utf-8", errors="replace")

# Quatre profils qui couvrent tous les cas de la logique d'accès -------------
CLIENTS = [
    {
        "Nom": "Aymeric Jamet — accès de démonstration",
        "Email": "jamet.aymeric.pro@gmail.com",
        "Jeton": "BRIEF-DEMO-2026",
        "Date début": "2026-01-01",
        "Date fin": "2027-12-31",
        "Utilisateurs illimités": True,
        "Actif": True,
        "Plan": "Offert",
        "Rôle": "Admin",
        "Notifications": True,
        "Notes": "Jeton principal de développement. Valide, illimité.",
    },
    {
        "Nom": "Lycée Jean-Moulin — abonnement à venir",
        "Email": "cdi@exemple-lycee.fr",
        "Jeton": "BRIEF-EDU-9K4T",
        "Date début": "2026-09-01",
        "Date fin": "2027-06-30",
        "Utilisateurs illimités": True,
        "Actif": True,
        "Plan": "Institution",
        "Rôle": "Lecteur",
        "Notifications": True,
        "Notes": "Cas de test : abonnement qui n'a pas encore commencé.",
    },
    {
        "Nom": "Marie Duval — abonnement expiré",
        "Email": "marie.duval@exemple.fr",
        "Jeton": "BRIEF-EXPIRE-1",
        "Date début": "2026-01-01",
        "Date fin": "2026-06-30",
        "Utilisateurs illimités": False,
        "Places": 1,
        "Actif": True,
        "Plan": "Mensuel",
        "Rôle": "Lecteur",
        "Notes": "Cas de test : date de fin dépassée.",
    },
    {
        "Nom": "Compte suspendu — test",
        "Email": "suspendu@exemple.fr",
        "Jeton": "BRIEF-OFF-1",
        "Date début": "2026-01-01",
        "Date fin": "2027-12-31",
        "Utilisateurs illimités": True,
        "Actif": False,
        "Plan": "Annuel",
        "Rôle": "Lecteur",
        "Notes": "Cas de test : dates valides mais case « Actif » décochée.",
    },
]

REGLAGES = [
    ("app_nom", "Brief", "Nom affiché dans l'en-tête"),
    ("app_baseline", "L'essentiel de l'actualité, chaque soir.",
     "Accroche affichée sur l'écran de connexion"),
    ("heure_publication", "18:30",
     "Heure de publication annoncée aux lecteurs (Europe/Paris)"),
    ("notification_titre", "Votre brief du soir est arrivé",
     "Titre de la notification « nouveau brief »"),
    ("message_accueil", "",
     "Bandeau optionnel affiché en haut de l'app. Vide = masqué."),
    ("contact_email", "jamet.aymeric.pro@gmail.com",
     "Adresse affichée en cas de problème d'accès"),
    ("version_schema", "1.0", "Version du schéma de la base"),
]


def upsert(table, cle, lignes):
    """Insère ou met à jour selon la valeur du champ `cle`."""
    existants = {
        r["fields"].get(cle): r["id"]
        for r in select(table, fields=[cle])
        if r["fields"].get(cle)
    }
    a_creer = [l for l in lignes if l[cle] not in existants]
    a_majer = [
        {"id": existants[l[cle]], "fields": l} for l in lignes if l[cle] in existants
    ]
    if a_creer:
        create(table, a_creer)
    if a_majer:
        update(table, a_majer)
    return len(a_creer), len(a_majer)


if __name__ == "__main__":
    c, m = upsert("clients", "Jeton", CLIENTS)
    print(f"Clients : {c} créé(s), {m} mis à jour")

    lignes = [{"Clé": k, "Valeur": v, "Description": d} for k, v, d in REGLAGES]
    c, m = upsert("reglages", "Clé", lignes)
    print(f"Réglages : {c} créé(s), {m} mis à jour")

    print("\nJetons de test :")
    for cl in CLIENTS:
        etat = "valide" if cl["Nom"].startswith("Aymeric") else "à tester"
        print(f"  {cl['Jeton']:<18} {cl['Nom']}")
