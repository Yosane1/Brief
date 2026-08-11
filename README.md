# Brief

Application de lecture d'une lettre d'information quotidienne, dans l'esprit de
brief.me. Un seul fichier `index.html`, adossé à une base Airtable.

- **Lecture** d'une édition du jour, découpée en rubriques éditoriales
- **Archives** consultables, navigation par date
- **Explorer** : tout le corpus par rubrique, par thématique et par mot-clé
- **Recherche** plein texte sur tous les briefs publiés
- **Accès par jeton**, accordé ou révoqué depuis Airtable, avec dates de validité
- **Application installable** (PWA) avec notifications à la parution
- **Apparence et libellés** pilotés depuis Airtable, sans déploiement
- **Publication automatisée** chaque soir par Claude Code cloud

---

## Démarrage

L'application est un fichier statique. Il suffit de l'ouvrir :

```bash
python -m http.server 8765
```

Puis <http://localhost:8765>. (L'ouvrir directement en `file://` fonctionne
aussi, mais un serveur local évite les surprises de cache.)

### Se connecter

La connexion demande **un identifiant et un mot de passe**. L'identifiant est
l'adresse e-mail du client, ou le champ `Identifiant` de la table Clients s'il
est renseigné — ce qui permet un login qui ne soit pas une adresse. Le mot de
passe est le champ `Jeton`.

Les comptes de test livrés avec le projet utilisent des adresses en
`@exemple.fr` et couvrent les quatre refus possibles : abonnement pas encore
commencé, expiré, désactivé, et couple invalide.

Un couple faux renvoie toujours le même message, quelle que soit la partie
erronée : distinguer « identifiant inconnu » de « mot de passe incorrect »
permettrait de découvrir quels comptes existent.

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

La table **Réglages** est relue à chaque démarrage : une valeur changée
s'applique au rechargement suivant, sans déploiement.

| Clé | Effet |
|---|---|
| `app_nom`, `app_point` | Le logo de l'en-tête. Le second est le signe coloré accolé au nom |
| `app_baseline` | L'accroche de l'écran de connexion |
| `app_description` | La description de l'application installée |
| `portail_label_identifiant`, `portail_label_jeton` | Les libellés des deux champs de connexion |
| `couleur_accent` | Couleur principale : logo, boutons, liens, rubrique « On rembobine » |
| `couleur_accent_weekend` | Couleur des éditions « Extra du samedi » |
| `theme_defaut` | `clair`, `sombre` ou `auto` au premier lancement |
| `nav_*` | Les quatre libellés de navigation |
| `titre_*`, `soustitre_*` | Les titres et chapôs des pages Archives, Explorer, Recherche |
| `portail_intro`, `portail_bouton` | Les textes de l'écran de connexion |
| `message_accueil` | Bandeau d'information en haut de l'app. Vide = masqué |
| `notification_titre` | Le titre de la notification « nouveau brief » |
| `contact_email` | L'adresse affichée en cas de problème d'accès |

**Pour ajouter un libellé personnalisable**, aucune ligne de JavaScript n'est
nécessaire : créez la clé dans Airtable, et posez `data-reglage="votre_cle"` sur
l'élément HTML concerné. Son contenu sera remplacé au chargement.

### Trois réglages qui ne s'appliquent pas tout seuls

`app_nom`, `app_description` et `couleur_accent` pilotent aussi **l'identité de
l'application installée** : son nom sous l'icône, sa description dans le
sélecteur d'applications, la couleur de son écran de démarrage. Ces
informations-là ne sont pas lues par la page mais par le système
d'exploitation, dans `manifest.webmanifest`, **avant** que le moindre
JavaScript ne s'exécute. Aucun code de la page ne peut les changer après coup.

Il faut donc régénérer le fichier :

```bash
python scripts/generer_manifeste.py
```

Le script relit les réglages, réécrit `manifest.webmanifest`, redessine les
icônes à la couleur d'accent et met à jour le titre et la description dans
`index.html`. Re-téléversez ensuite ces trois éléments.

**Sur un téléphone où l'application est déjà installée, il faut la désinstaller
puis la réinstaller** : le système ne relit le manifeste qu'à l'installation.
C'est la raison pour laquelle un changement de nom semble « ne pas être pris en
compte sur mobile » alors qu'il l'est parfaitement dans le navigateur.

---

## Comment fonctionne l'accès

À chaque connexion **et à chaque rechargement de page**, le jeton est revérifié
auprès d'Airtable. Une révocation prend donc effet au prochain chargement, sans
attendre d'expiration de session.

Les contrôles, dans l'ordre :

1. Le couple identifiant / mot de passe correspond-il à une ligne de la table
   Clients ? (comparaison insensible à la casse et aux espaces)
2. La case **Actif** est-elle cochée ? — c'est le coupe-circuit immédiat
3. La **date de début** est-elle passée ?
4. La **date de fin** est-elle à venir ?
5. Si **Utilisateurs illimités** est décoché et que **Places** vaut *N* : le
   nombre d'appareils distincts déjà connectés avec ce jeton est compté dans le
   Journal, et l'accès est refusé au-delà de *N*.

Pour accorder un accès : ajouter une ligne dans **Clients**, remplir `Email`
(ou `Identifiant`), `Jeton`, `Date début`, `Date fin`, et cocher `Actif`. Pour
le révoquer : décocher `Actif`, ou avancer la date de fin.

`scripts/seed_acces.py` n'ajoute que ce qui manque et ne réécrit jamais une
ligne existante : le relancer ne réactivera pas un abonnement suspendu, ni ne
remettra une couleur choisie à sa valeur d'usine. `--ecraser` force la
réinitialisation, quand c'est vraiment ce que l'on veut.

---

## La publication du soir

Le pipeline se lance avec une seule commande dans Claude Code :

```bash
/brief-du-soir
```

Il enchaîne quatre étapes :

| Étape | Script | Ce qu'elle fait |
|---|---|---|
| 1. Collecter | `scripts/fetch_news.py` | Agrège 11 flux RSS (Le Monde, franceinfo, France 24, Libération, BBC, Futura…), dédoublonne, filtre sur 26 h |
| 2. Écrire | *(Claude)* | Sélectionne les sujets, rédige, produit `editions/AAAA-MM-JJ.json` |
| 3. Publier | `scripts/push_edition.py` | Upsert dans Airtable — relancer sur la même date ne crée pas de doublon |
| 4. Vérifier | `scripts/verifier_edition.py` | Relit l'édition avec la requête de l'app et signale ce qui s'afficherait mal |

Les règles éditoriales — équilibre des rubriques, longueur, sourçage, ton,
format du week-end — sont dans `.claude/commands/brief-du-soir.md`. Le format
du JSON attendu est documenté champ par champ dans `editions/_modele.json`.
Ce sont ces deux fichiers qu'il faut modifier pour infléchir la ligne
éditoriale : ni la routine, ni les workflows.

### Deux contextes d'exécution, une seule procédure

La procédure commence par tester si Airtable est joignable, et se comporte
différemment selon la réponse :

- **Depuis un poste** — accès réseau complet : elle collecte et publie en direct.
- **Depuis la routine cloud** — le proxy des sessions Claude Code n'autorise que
  GitHub, les registres de paquets et l'API Anthropic. Ni les flux RSS ni
  `api.airtable.com` ne répondent. La procédure lit alors la veille déposée dans
  le dépôt et publie en committant l'édition.

Cette limite est délibérée et n'est pas configurable : la demande de l'ouvrir
depuis un dépôt a été fermée en « not planned »
([issue #52982](https://github.com/anthropics/claude-code/issues/52982)).
D'où le montage qui suit.

### L'enchaînement automatisé

Le réseau est pris en charge par GitHub Actions, qui encadre la routine :

| Heure (Paris) | Qui | Quoi |
|---|---|---|
| 17h50 | `.github/workflows/collecte.yml` | Collecte les flux, dépose `veille.json` dans le dépôt |
| 18h30 | Routine Claude Code cloud | Lit la veille, rédige, commite `editions/AAAA-MM-JJ.json` |
| 18h32 | `.github/workflows/publication.yml` | Écrit dans Airtable et vérifie l'édition |

GitHub Actions est gratuit sur dépôt privé (2 000 min/mois, ce pipeline en
consomme une centaine) et la rédaction reste sur l'abonnement Claude : aucune
clé API, aucune facturation supplémentaire.

Les deux workflows se lancent aussi à la main depuis l'onglet **Actions** du
dépôt — `publication.yml` accepte une date en paramètre pour republier une
édition passée.

**Les crons sont en UTC.** `50 15` et `30 16` correspondent à 17h50 et 18h30 en
heure d'été ; au passage à l'heure d'hiver, fin octobre, il faut les avancer
d'une heure (`50 16` et `30 17`) pour conserver les mêmes horaires à Paris.

### Chaque étape est utilisable seule

```bash
python scripts/fetch_news.py --hours 48 --out veille.json
python scripts/push_edition.py editions/2026-08-12.json --brouillon
python scripts/verifier_edition.py 2026-08-12
```

Le drapeau `--brouillon` publie en statut Brouillon : l'édition reste invisible
dans l'application, le temps d'une relecture.

### Corriger une édition déjà parue

Modifier un article directement dans Airtable fonctionne, mais **la retouche est
perdue à la première republication** : `push_edition.py` supprime tous les
articles de la date avant de les réécrire. Pour une correction durable, éditez
`editions/AAAA-MM-JJ.json` et republiez-le.

---

## Application installable et notifications

L'application est une PWA : `manifest.webmanifest` la décrit, `sw.js` en est le
service worker, et `icones/` contient les images générées par
`scripts/generer_icones.py` (aucune dépendance : l'encodeur PNG tient dans le
script).

Une fois installée depuis Android, iOS ou le navigateur de bureau, elle s'ouvre
en plein écran, sans barre d'adresse, avec sa propre icône — et non comme un
raccourci web. Sur mobile, la navigation passe en barre d'onglets basse.

Le service worker met aussi en cache la coquille de l'application, ce qui permet
de relire le dernier brief consulté hors ligne. Les données Airtable, elles, ne
sont jamais mises en cache : un brief périmé affiché comme frais serait pire que
pas de brief du tout.

### Les notifications

L'application compare, toutes les dix minutes et à chaque retour sur l'onglet,
la dernière édition publiée à la dernière vue par le lecteur. Quand un nouveau
brief paraît, elle affiche une notification système et un bandeau cliquable.
L'activation se fait dans le menu de compte, « Alerte nouveau brief ».

Les notifications passent obligatoirement par
`ServiceWorkerRegistration.showNotification()` : **Chrome Android refuse
`new Notification()`**, il lève une exception et n'affiche rien. C'est la cause
la plus fréquente de « les notifications ne marchent pas sur Android ».

**Deux conditions à respecter :**

1. **Une origine sécurisée.** Service worker, installation et notifications
   exigent HTTPS — ou `localhost` en développement. Ouverte en `file://` ou
   servie en HTTP simple sur le réseau local, l'application fonctionne mais
   n'est ni installable ni capable de notifier. C'est silencieux : le navigateur
   n'affiche aucune erreur.
2. **L'application doit avoir été ouverte au moins une fois** depuis la
   parution. La vérification est faite par le client, pas par un serveur.

Une vraie notification *push*, reçue application fermée, suppose un serveur qui
signe ses envois avec des clés VAPID. Les appareils sont déjà collectés dans la
table **Abonnements push** en prévision, et `sw.js` contient déjà le gestionnaire
d'événement `push` : le jour où ce serveur existera, la page n'aura pas à
changer. Cela ira naturellement avec la migration Firebase décrite plus bas.

---

## La passerelle d'accès

**Déployée** sur `https://brief.jamet-aymeric-pro.workers.dev`.
`index.html` ne contient plus aucun jeton.

### Le problème qu'elle résout

Sans passerelle, l'application interroge Airtable directement avec un jeton
inscrit dans `index.html`. Conséquence : **toute personne qui ouvre la page peut
en extraire le jeton et lire comme écrire l'intégralité de la base**, y compris
les adresses et les jetons de tous les abonnés. L'écran de connexion protège
l'interface, pas les données.

Acceptable en développement local. Plus du tout dès qu'une URL est partagée.

`worker/brief-worker.js` règle la question. Ce n'est volontairement pas un
relais transparent : un relais qui accepterait n'importe quelle requête
Airtable déplacerait le problème sans le résoudre, puisque l'adresse du Worker
rouvrirait la base entière. Chaque route ne renvoie que ce qui est nécessaire,
et la table Clients n'est jamais exposée — elle ne sert qu'à valider un jeton.

| Route | Rôle |
|---|---|
| `GET /reglages` | Les réglages d'affichage (accessible avant connexion) |
| `POST /connexion` | Valide un jeton, renvoie une session signée d'une heure |
| `GET /editions` | La liste des éditions publiées |
| `GET /edition?slug=` | Les articles d'une édition |
| `GET /articles?q=…` | Recherche et filtres |
| `GET /vivier` | Les articles allégés, pour la vue Explorer |
| `POST /journal` | Trace une lecture ou une recherche |
| `POST /abonnement` | Enregistre l'appareil pour les notifications |

Toutes les routes sauf les deux premières exigent une session valide. Une
session dure une heure : c'est le délai maximal entre une révocation dans
Airtable et la perte effective de l'accès. Le renouvellement est transparent
pour le lecteur.

### Où vit le jeton Airtable

Il ne doit exister qu'à deux endroits, tous deux chiffrés :

| Emplacement | Pour quoi faire |
|---|---|
| Secret Cloudflare `AIRTABLE_TOKEN` | La lecture par l'application |
| Secret GitHub `AIRTABLE_TOKEN` | La publication du soir par `publication.yml` |

`scripts/airtable.py` conserve une valeur de repli en clair, pratique pour un
usage local mais présente dans le dépôt. Une fois le secret GitHub renseigné,
la vider est le bon réflexe : les workflows le liront depuis le secret.

**En cas de fuite, remplacer le jeton aux deux endroits** après l'avoir
régénéré sur [airtable.com/create/tokens](https://airtable.com/create/tokens).

### Déployer, en dix minutes

1. Créer un compte sur [dash.cloudflare.com](https://dash.cloudflare.com) —
   gratuit, sans carte bancaire.
2. **Workers & Pages → Create → Workers → Create Worker**. Le nommer `brief`,
   puis **Deploy** (le code d'exemple sera remplacé).
3. **Edit code**, tout sélectionner, coller le contenu de
   `worker/brief-worker.js`, puis **Deploy**.
4. **Settings → Variables and Secrets**, ajouter :

   | Type | Nom | Valeur |
   |---|---|---|
   | Secret | `AIRTABLE_TOKEN` | le jeton Airtable |
   | Secret | `SESSION_SECRET` | une longue chaîne aléatoire, au choix |
   | Text | `BASE_ID` | `appzxFhyARS0LjDFc` |
   | Text | `ORIGINES` | `https://filedn.com` |

   `ORIGINES` liste les sites autorisés à appeler la passerelle, séparés par des
   virgules. En ajoutant `http://localhost:8765`, le développement local
   continue de fonctionner à travers elle.

5. Relever l'adresse du Worker, de la forme
   `https://brief.votre-compte.workers.dev`. La visiter doit afficher
   `{"service":"brief","etat":"ok"}`.
6. Dans `index.html`, renseigner `CONF.api` avec cette adresse **et vider
   `CONF.jetonAirtable`**. Le jeton ne se trouve alors plus nulle part côté
   navigateur.
7. **Régénérer le jeton Airtable** et reporter le nouveau dans le secret du
   Worker : l'ancien a circulé, il doit être révoqué.

Les scripts Python continuent d'utiliser le jeton directement — ils tournent
côté serveur, c'est leur place.

### Ce qu'il reste possible d'ajouter

Les notifications *push* reçues application fermée demandent un serveur qui
signe ses envois avec des clés VAPID. Le Worker est l'endroit naturel pour cela,
et `sw.js` contient déjà le gestionnaire `push` correspondant.

---

## Organisation des fichiers

```
index.html                          l'application
manifest.webmanifest                description de l'app installable
sw.js                               service worker : install, notifications, hors ligne
icones/                             icônes générées, référencées par le manifeste
veille.json                         matière collectée, déposée par GitHub Actions
editions/
  _modele.json                      le format documenté champ par champ
  2026-08-08.json                   les éditions parues, une par jour
  2026-08-10.json
  2026-08-11.json
scripts/
  airtable.py                       client Airtable partagé
  setup_airtable.py                 crée le schéma (idempotent)
  seed_acces.py                     jetons de test et réglages (idempotent)
  fetch_news.py                     collecte RSS
  push_edition.py                   publication (upsert)
  verifier_edition.py               contrôle de cohérence
  generer_icones.py                 icônes PNG, sans dépendance
.claude/
  commands/brief-du-soir.md         la procédure et les règles éditoriales
  launch.json                       serveur local pour la prévisualisation
.github/workflows/
  collecte.yml                      17h50 — dépose la veille dans le dépôt
  publication.yml                   sur commit d'édition — écrit dans Airtable
```

Seuls `_modele.json` et `brief-du-soir.md` sont à toucher pour faire évoluer la
ligne éditoriale. Le reste est de la plomberie.

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
