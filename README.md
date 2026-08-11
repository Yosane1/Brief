# Brief

Application de lecture d'une lettre d'information quotidienne, dans l'esprit de
brief.me. Un seul fichier `index.html`, adossé à une base Airtable.

- **Lecture** d'une édition du jour, découpée en rubriques éditoriales
- **Archives** consultables, navigation par date
- **Recherche** plein texte sur tous les briefs publiés
- **Accès par jeton**, accordé ou révoqué depuis Airtable, avec dates de validité
- **Notifications** à la parution d'un nouveau brief
- **Publication automatisée** chaque soir par Claude Code cloud

---

## Démarrage

L'application est un fichier statique. Il suffit de l'ouvrir :

```bash
python -m http.server 8765
```

Puis <http://localhost:8765>. (L'ouvrir directement en `file://` fonctionne
aussi, mais un serveur local évite les surprises de cache.)

### Jetons de test

| Jeton | Cas couvert |
|---|---|
| `BRIEF-DEMO-2026` | Accès valide, utilisateurs illimités, rôle Admin |
| `BRIEF-EDU-9K4T` | Abonnement qui ne démarre que le 1ᵉʳ septembre 2026 |
| `BRIEF-EXPIRE-1` | Abonnement expiré le 30 juin 2026 |
| `BRIEF-OFF-1` | Dates valides mais case « Actif » décochée |

Chaque jeton produit un message d'erreur différent et explicite.

---

## La base Airtable

Base **Brief - actualité du jour** — `appzxFhyARS0LjDFc`

| Table | ID | Rôle |
|---|---|---|
| Éditions | `tbl3iBc69xGDR5Sg8` | Une ligne = un brief. Unité publiée. |
| Articles | `tblBCSPDzwOWv1oMn` | Le contenu, découpé par rubrique. |
| Clients | `tbl7g2e6qkj89IApu` | Les accès et leurs dates de validité. |
| Abonnements push | `tblD3A0snPC239bgo` | Appareils inscrits aux notifications. |
| Journal | `tblKOTUxKjS6IgOOj` | Connexions, lectures, recherches. |
| Réglages | `tbl0n9LTnbmLWArwu` | Paramètres lus au démarrage de l'app. |

Le schéma est reproductible : `python scripts/setup_airtable.py` recrée tout ce
qui manque sans toucher à l'existant.

### Deux points à connaître

**Aucun champ formule.** L'API Airtable ne permet pas de créer des champs
formule, rollup ou lookup. La validité d'un abonnement est donc calculée côté
application, à partir des champs bruts (`Actif`, `Date début`, `Date fin`).

**`DATESTR()` est obligatoire.** Comparer un champ date à une chaîne avec `=`
dans un `filterByFormula` ne renvoie jamais rien. Il faut
`DATESTR({Date}) = '2026-08-11'`. C'est la cause d'erreur la plus fréquente sur
cette base.

### Réglages modifiables sans toucher au code

La table **Réglages** est lue au démarrage. `app_baseline` change l'accroche de
l'écran de connexion, `notification_titre` le titre des notifications,
`contact_email` l'adresse affichée en cas de problème d'accès.

---

## Comment fonctionne l'accès

À chaque connexion **et à chaque rechargement de page**, le jeton est revérifié
auprès d'Airtable. Une révocation prend donc effet au prochain chargement, sans
attendre d'expiration de session.

Les contrôles, dans l'ordre :

1. Le jeton existe-t-il ? (comparaison insensible à la casse et aux espaces)
2. La case **Actif** est-elle cochée ? — c'est le coupe-circuit immédiat
3. La **date de début** est-elle passée ?
4. La **date de fin** est-elle à venir ?
5. Si **Utilisateurs illimités** est décoché et que **Places** vaut *N* : le
   nombre d'appareils distincts déjà connectés avec ce jeton est compté dans le
   Journal, et l'accès est refusé au-delà de *N*.

Pour accorder un accès : ajouter une ligne dans **Clients**, remplir `Jeton`,
`Date début`, `Date fin`, cocher `Actif`. Pour le révoquer : décocher `Actif`,
ou avancer la date de fin.

---

## La publication du soir

Le pipeline se lance avec une seule commande dans Claude Code :

```bash
/brief-du-soir
```

Elle enchaîne quatre étapes :

| Étape | Script | Ce qu'elle fait |
|---|---|---|
| 1. Collecter | `scripts/fetch_news.py` | Agrège 11 flux RSS (Le Monde, franceinfo, France 24, Libération, BBC, Futura…), dédoublonne, filtre sur 26 h |
| 2. Écrire | *(Claude)* | Sélectionne les sujets, rédige, produit `editions/AAAA-MM-JJ.json` |
| 3. Publier | `scripts/push_edition.py` | Upsert dans Airtable — relancer sur la même date ne crée pas de doublon |
| 4. Vérifier | `scripts/verifier_edition.py` | Relit l'édition avec la requête de l'app et signale ce qui s'afficherait mal |

Les règles éditoriales — équilibre des rubriques, longueur, sourçage, ton,
format du week-end — sont dans `.claude/commands/brief-du-soir.md`. C'est là
qu'il faut intervenir pour infléchir la ligne éditoriale.

### Chaque étape est utilisable seule

```bash
python scripts/fetch_news.py --hours 48 --out veille.json
python scripts/push_edition.py editions/2026-08-12.json --brouillon
python scripts/verifier_edition.py 2026-08-12
```

Le drapeau `--brouillon` publie en statut Brouillon : l'édition reste invisible
dans l'application, le temps d'une relecture.

### Programmer l'exécution quotidienne

L'automatisation n'est **pas encore programmée**. Pour l'activer, demander dans
Claude Code :

> Programme `/brief-du-soir` tous les jours à 18h30, du lundi au samedi.

Le dimanche est traité par la commande elle-même : elle constate le jour et
s'arrête sans publier.

---

## Notifications

L'application compare, toutes les dix minutes et à chaque retour sur l'onglet,
la dernière édition publiée à la dernière vue par le lecteur. Quand un nouveau
brief paraît, elle affiche une notification système et un bandeau cliquable.

L'activation se fait dans le menu de compte, « Alerte nouveau brief ».
L'appareil est alors enregistré dans **Abonnements push** et la case
`Notifications` du client est cochée.

**Limite actuelle :** cela ne fonctionne que si l'application est ouverte dans un
onglet. Une vraie notification *push* — reçue application fermée — suppose un
service worker et un serveur qui signe les envois avec des clés VAPID. Les
appareils sont déjà collectés dans Airtable en prévision de cette étape, qui ira
naturellement avec la migration Firebase décrite ci-dessous.

---

## Passage en production

### Le sujet à traiter en premier

Le jeton Airtable est **en clair dans `index.html`**, comme convenu pour la phase
de développement. Conséquence concrète : toute personne qui ouvre la page peut
lire le code source, récupérer le jeton, et **lire comme écrire l'intégralité de
la base** — y compris la table Clients. Le contrôle d'accès par jeton protège
l'interface, pas les données.

C'est acceptable tant que l'application n'est pas publiée. Ça ne l'est plus le
jour où une URL est partagée.

### La migration

1. Créer un projet Firebase et deux Cloud Functions :
   - `POST /connexion` — reçoit un jeton, applique les cinq contrôles de
     validité, renvoie un jeton de session court (JWT, quelques heures)
   - `GET /contenu` — vérifie le JWT, interroge Airtable côté serveur, renvoie
     éditions et articles
2. Déplacer le jeton Airtable dans la configuration de la fonction
   (`firebase functions:secrets:set AIRTABLE_TOKEN`). Il ne quitte plus le serveur.
3. Dans `index.html`, remplacer les fonctions `airtable()` et `airtableTout()`
   par des appels aux deux endpoints. C'est le seul point de contact avec
   Airtable : tout le reste du code est inchangé.
4. **Régénérer le jeton Airtable**, l'ancien ayant circulé.
5. Ajouter Firebase Cloud Messaging pour les notifications push réelles.

Les scripts Python continuent d'utiliser le jeton directement — ils tournent
côté serveur, c'est leur place.

---

## Organisation des fichiers

```
index.html                          l'application (autonome)
editions/                           les éditions au format JSON
  2026-08-08.json                   extra du samedi
  2026-08-10.json                   quotidienne
  2026-08-11.json                   quotidienne — modèle de référence
scripts/
  airtable.py                       client Airtable partagé
  setup_airtable.py                 crée le schéma (idempotent)
  seed_acces.py                     jetons de test et réglages (idempotent)
  fetch_news.py                     collecte RSS
  push_edition.py                   publication (upsert)
  verifier_edition.py               contrôle de cohérence
.claude/
  commands/brief-du-soir.md         la commande de publication du soir
  launch.json                       serveur local pour la prévisualisation
```

---

## Notes

**Les appels HTTP passent par `curl`.** Les scripts Python n'utilisent pas
`urllib` : l'inspection TLS présente sur le poste de développement casse la
vérification de certificat de Python, là où `curl` fonctionne. Si les scripts
sont déplacés sur une machine sans ce problème, `airtable.py` peut revenir à
`urllib` sans autre changement.

**Le nommage des rubriques** reprend celui de brief.me (« On rembobine »,
« Tout s'explique »…). C'est cohérent avec l'objectif de reproduire ce format,
mais ces intitulés sont l'habillage éditorial d'un titre de presse existant. En
cas de diffusion publique, mieux vaut les renommer : ils sont centralisés dans
la constante `RUBRIQUES` d'`index.html` et dans le champ `Rubrique` d'Airtable.

**Les trois éditions en base sont composées de dépêches réelles** des 8, 10 et
11 août 2026, collectées par `fetch_news.py`. Elles servent de démonstration et
peuvent être supprimées depuis Airtable.
