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

# Tout ce qui est modifiable sans toucher au code. L'application relit cette
# table à chaque démarrage : une valeur changée ici s'applique au rechargement.
REGLAGES = [
    # — Identité ————————————————————————————————————————————————
    ("app_nom", "brief",
     "Nom affiché dans l'en-tête, en gras à gauche"),
    ("app_point", "•",
     "Signe coloré accolé au nom. Un point « . » pour un logo sobre, vide pour rien"),
    ("app_baseline", "L'essentiel de l'actualité, chaque soir.",
     "Accroche de l'écran de connexion"),
    ("app_description",
     "Le brief quotidien : l'actualité résumée, contextualisée et expliquée en moins de sept minutes.",
     "Description de l'application installée. Nécessite generer_manifeste.py"),

    # — Couleurs ————————————————————————————————————————————————
    ("couleur_accent", "#ff4a59",
     "Couleur principale : logo, boutons, liens, rubrique « On rembobine »"),
    ("couleur_accent_weekend", "#7070f5",
     "Couleur des éditions « Extra du samedi »"),
    ("theme_defaut", "auto",
     "Thème au premier lancement : « clair », « sombre » ou « auto » (suit le système)"),

    # — Libellés de navigation ——————————————————————————————————
    ("nav_edition", "Aujourd'hui", "Onglet de l'édition du jour"),
    ("nav_archives", "Archives", "Onglet des éditions passées"),
    ("nav_explorer", "Explorer", "Onglet de navigation par rubrique et thématique"),
    ("nav_recherche", "Recherche", "Onglet de recherche"),

    # — Titres de pages —————————————————————————————————————————
    ("titre_archives", "Archives", "Titre de la page des archives"),
    ("titre_explorer", "Explorer", "Titre de la page Explorer"),
    ("titre_recherche", "Recherche", "Titre de la page de recherche"),
    ("soustitre_explorer",
     "Tous les articles parus, classés par rubrique, par thématique et par mot-clé.",
     "Phrase sous le titre de la page Explorer"),
    ("soustitre_recherche",
     "Cherchez dans l'ensemble des briefs publiés : titres, résumés, contenus et mots-clés.",
     "Phrase sous le titre de la page de recherche"),

    # — Écran de connexion ——————————————————————————————————————
    ("portail_intro",
     "Cette édition est réservée aux abonnés. Identifiez-vous avec l'adresse et le mot de passe qui vous ont été communiqués.",
     "Paragraphe d'explication sur l'écran de connexion"),
    ("portail_label_identifiant", "Identifiant", "Libellé du premier champ"),
    ("portail_label_jeton", "Mot de passe", "Libellé du second champ"),
    ("portail_bouton", "Accéder au brief", "Libellé du bouton de connexion"),

    # — Divers ——————————————————————————————————————————————————
    ("heure_publication", "18:30",
     "Heure de publication annoncée aux lecteurs (Europe/Paris)"),
    ("notification_titre", "Votre brief du soir est arrivé",
     "Titre de la notification « nouveau brief »"),
    ("message_accueil", "",
     "Bandeau d'information affiché en haut de l'app. Vide = masqué"),
    ("contact_email", "jamet.aymeric.pro@gmail.com",
     "Adresse affichée en cas de problème d'accès"),
    ("version_schema", "1.1", "Version du schéma de la base"),
]


def semer(table, cle, lignes, ecraser=False):
    """
    N'ajoute que ce qui manque.

    Ces deux tables sont éditées à la main : la table Réglages porte les
    personnalisations d'apparence, la table Clients l'état réel des accès.
    Réécrire une ligne existante remettrait une couleur choisie à sa valeur
    d'usine, ou réactiverait un abonnement volontairement suspendu. Relancer ce
    script doit rester sans effet de bord.
    """
    existants = {
        r["fields"].get(cle): r["id"]
        for r in select(table, fields=[cle])
        if r["fields"].get(cle)
    }
    a_creer = [l for l in lignes if l[cle] not in existants]
    ignores = len(lignes) - len(a_creer)
    if a_creer:
        create(table, a_creer)
    if ecraser:
        update(table, [{"id": existants[l[cle]], "fields": l}
                       for l in lignes if l[cle] in existants])
    return len(a_creer), ignores


if __name__ == "__main__":
    import sys
    ecraser = "--ecraser" in sys.argv
    if ecraser:
        print("⚠ Mode --ecraser : les valeurs existantes seront réinitialisées.\n")

    c, i = semer("clients", "Jeton", CLIENTS, ecraser)
    print(f"Clients  : {c} créé(s), {i} déjà présent(s){'' if ecraser else ' et laissé(s) intact(s)'}")

    lignes = [{"Clé": k, "Valeur": v, "Description": d} for k, v, d in REGLAGES]
    c, i = semer("reglages", "Clé", lignes, ecraser)
    print(f"Réglages : {c} créé(s), {i} déjà présent(s){'' if ecraser else ' et laissé(s) intact(s)'}")

    print("\nJetons de test :")
    for cl in CLIENTS:
        etat = "valide" if cl["Nom"].startswith("Aymeric") else "à tester"
        print(f"  {cl['Jeton']:<18} {cl['Nom']}")
