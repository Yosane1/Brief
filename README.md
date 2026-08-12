# Brief

Application de lecture d'une lettre d'information quotidienne. Un seul fichier `index.html`, adossé à une base Airtable.

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

Il enchaîne cinq étapes :

| Étape | Script | Ce qu'elle fait |
|---|---|---|
| 1. Collecter | `scripts/fetch_news.py` | Agrège 11 flux RSS (Le Monde, franceinfo, France 24, Libération, BBC, Futura…), dédoublonne, filtre sur 26 h |
| 2. Choisir | `scripts/depeches.py` | Claude présélectionne sur les titres, puis lit les résumés des seuls candidats retenus |
| 3. Écrire | *(Claude)* | Rédige et produit `editions/AAAA/AAAA-MM-JJ.json` |
| 4. Publier | `scripts/push_edition.py` | Upsert dans Airtable — relancer sur la même date ne crée pas de doublon |
| 5. Vérifier | `scripts/verifier_edition.py` | Relit l'édition avec la requête de l'app et signale ce qui s'afficherait mal |

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
| 16h00 | `.github/workflows/collecte.yml` | Collecte les flux, dépose `veille.jsonl`, envoie le compte rendu |
| 17h31 | Routine Claude Code cloud | Lit la veille, rédige, commite `editions/AAAA/AAAA-MM-JJ.json` |
| ~17h35 | `.github/workflows/publication.yml` | Écrit dans Airtable, vérifie, notifie les abonnés |

GitHub Actions est gratuit sur dépôt privé (2 000 min/mois, ce pipeline en
consomme une centaine) et la rédaction reste sur l'abonnement Claude : aucune
clé API, aucune facturation supplémentaire.

Les deux workflows se lancent aussi à la main depuis l'onglet **Actions** du
dépôt — `publication.yml` accepte une date en paramètre pour republier une
édition passée.

**Les crons sont en UTC.** `0 14` correspond à 16h00 en heure d'été ; au passage
à l'heure d'hiver, fin octobre, il faut l'avancer d'une heure (`0 15`) pour
conserver le même horaire à Paris. La routine de rédaction se planifie ailleurs,
dans la console des routines Claude Code, et suit la même règle.

**L'écart entre les deux est le point faible du montage.** Les workflows
programmés de GitHub sont mis en file et peuvent partir très en retard : le
11 août, cette collecte a démarré avec quarante-huit minutes de retard. D'où
les quatre-vingt-onze minutes de marge, et d'où le compte rendu envoyé à la fin
de la collecte, qui compare l'heure réelle de fin à `HEURE_ROUTINE` et prévient
quand la marge fond. Si la collecte se termine après le passage de la routine,
celle-ci lit une veille vieille de plus de douze heures et s'arrête : il n'y a
pas d'édition ce soir-là.

Pour recevoir ce compte rendu, trois secrets sont à créer dans **Settings →
Secrets and variables → Actions** : `MAIL_DESTINATAIRE`, `MAIL_UTILISATEUR` et
`MAIL_MOT_DE_PASSE` (un mot de passe d'application Google, pas le mot de passe
du compte). L'envoi est toujours tenté : s'ils manquent, l'étape échoue et
GitHub signale le workflow en échec, ce qui reste une alerte. Une étape sautée
en silence, elle, n'en serait pas une.

### Pourquoi la veille tient en deux fichiers

Sur les quelque 190 dépêches d'une journée, **une trentaine finit citée**. Les
charger toutes en entier pour en utiliser trente dépensait les trois quarts du
contexte de la session en pure perte — et ce contexte est renvoyé au modèle à
chaque appel d'outil.

La collecte écrit donc deux fichiers :

| Fichier | Contenu | Qui le lit |
|---|---|---|
| `veille.jsonl` | identifiant, date, source, rubrique, **titre** | Claude, en entier |
| `veille/AAAA-MM-JJ.json` | les mêmes, plus **URL** et **résumé** | jamais Claude |

Claude choisit ses sujets sur les titres, puis réclame les résumés des seuls
candidats retenus — `python scripts/depeches.py lm042 fi017 …`. Les URL, il ne
les voit jamais : il cite des identifiants, et `push_edition.py` les résout à
la publication.

Le contexte d'une session passe de 133 à 60 Ko, dont 13 Ko de résumés
réellement utiles. **Et plus aucune URL ne peut être inventée ou tronquée** :
`verifier_edition.py` refuse de laisser passer une source non résolue.

La contrepartie est une règle éditoriale ferme, inscrite dans la procédure :
*ne jamais écrire un article dont le résumé n'a pas été lu*. Un titre annonce
un sujet, il ne porte ni chiffre vérifiable, ni attribution, ni nuance. La
présélection vise donc large — 40 à 60 dépêches — et un résumé de plus ne coûte
que 250 octets.

Le dossier `veille/` n'est jamais écrasé : une édition republiée des mois plus
tard y retrouve ses sources. Il grossit d'environ 100 Ko par jour.

### Chaque étape est utilisable seule

```bash
python scripts/fetch_news.py --hours 48
python scripts/push_edition.py editions/2026/2026-08-12.json --brouillon
python scripts/verifier_edition.py 2026-08-12
```

Le drapeau `--brouillon` publie en statut Brouillon : l'édition reste invisible
dans l'application, le temps d'une relecture.

### Corriger une édition déjà parue

Modifier un article directement dans Airtable fonctionne, mais **la retouche est
perdue à la première republication** : `push_edition.py` supprime tous les
articles de la date avant de les réécrire. Pour une correction durable, éditez
`editions/AAAA/AAAA-MM-JJ.json` et republiez-le.

---

## Application installable et notifications

L'application est une PWA : `manifest.webmanifest` la décrit, `sw.js` en est le
service worker, et `icones/` contient les images générées par
`scripts/generer_icones.py` (aucune dépendance : l'encodeur PNG tient dans le
script).

Une fois installée depuis Android, iOS ou le navigateur de bureau, elle s'ouvre
en plein écran, sans barre d'adresse, avec sa propre icône — et non comme un
raccourci web. Sur mobile, la navigation passe en barre d'onglets basse.

Le service worker met en cache la coquille de l'application dans `brief-v4`, et
les briefs eux-mêmes dans un cache distinct, `brief-donnees` : ils survivent
ainsi au déploiement d'une nouvelle version, et disparaissent à la déconnexion —
un poste peut être partagé. Un brief servi depuis le cache après une panne de
réseau est daté par l'en-tête `X-Brief-Cache`, et l'application le dit au
lecteur : un brief d'avant-hier présenté comme frais serait pire que pas de
brief.

### Ne réveiller le réseau que lorsqu'il a quelque chose à dire

L'application interrogeait la passerelle à chaque démarrage, puis toutes les dix
minutes, du matin au soir : environ cent quarante appels par jour et par onglet
pour apprendre cent trente-neuf fois la même chose. Le brief ne paraît qu'une
fois par jour.

La décision d'aller en ligne se prend désormais **avant le premier appel**, sur
les seules données locales — l'heure de parution annoncée par la base, la date
de l'édition la plus récente connue, et celle du dernier contrôle :

| Situation | Au démarrage |
| --- | --- |
| Rechargement explicite (F5, balayage vers le bas) | réseau |
| Rien d'exploitable en mémoire (première visite, déconnexion) | réseau |
| L'édition attendue est déjà en mémoire | mémoire locale |
| Une édition plus récente peut exister | réseau |
| … mais la passerelle a déjà répondu il y a moins de 30 min | mémoire locale |
| Accès non vérifié depuis sept jours | réseau |

« L'édition attendue » est celle d'aujourd'hui une fois `heure_publication`
passée, celle d'hier avant. La question posée est bien « une édition que je n'ai
pas peut-elle exister ? », et non « sommes-nous après l'heure de parution ? » —
qui laisserait un lecteur du matin sur l'avant-veille quand l'édition d'hier
soir est arrivée en retard.

Le sondage périodique suit la même logique : il ne s'ouvre qu'entre
`heure_publication` et deux heures plus tard, et seulement tant que l'édition
attendue manque. Le reste du temps, aucun appel.

Le lecteur garde la main : un rechargement force toujours la mise à jour. Aucun
bouton n'a été ajouté — le geste est celui que tout le monde connaît déjà.

Deux garde-fous rendent ce mode sans risque. Si le cache se révèle insuffisant,
l'application rouvre le réseau et retombe sur le comportement d'avant. Et le
jeton n'est plus revérifié au démarrage, mais au premier appel réel : `appelAuth`
rejoue la connexion sur tout refus de la passerelle, si bien qu'un accès révoqué
relit ce qu'on lui avait déjà servi et tombe dès que l'application demande du
neuf. La péremption de sept jours ferme le cas de l'appareil qui ne se
reconnecterait plus jamais.

### Les notifications

Le brief est annoncé par une vraie notification *push* : elle arrive même
application fermée, téléphone en veille. Le lecteur l'active dans le menu de
compte, « Alerte nouveau brief ».

L'enchaînement, chaque soir :

1. `publication.yml` publie l'édition dans Airtable
2. le même workflow appelle `POST /diffuser` sur la passerelle
3. le Worker chiffre puis signe une notification par abonné, et la remet au
   service de push du navigateur — Google pour Chrome, Mozilla pour Firefox
4. le service de push réveille `sw.js` sur l'appareil, qui affiche l'alerte

La passerelle n'annonce jamais deux fois la même édition : relancer le workflow
est sans conséquence. Les abonnements révoqués côté navigateur (réponse 404 ou
410) sont automatiquement décochés dans la table **Abonnements push**.

Deux normes se combinent dans `worker/brief-worker.js`, et aucune n'est
optionnelle : **RFC 8291** chiffre le contenu, pour que le service de push
relaie sans jamais pouvoir lire la notification ; **RFC 8292** signe l'envoi,
pour prouver qu'il vient bien du serveur déclaré lors de l'abonnement.

L'affichage passe obligatoirement par
`ServiceWorkerRegistration.showNotification()` : **Chrome Android refuse
`new Notification()`**, il lève une exception et n'affiche rien. C'est la cause
la plus fréquente de « les notifications ne marchent pas sur Android ».

**Une condition demeure :** service worker, installation et notifications
exigent une origine sécurisée — HTTPS, ou `localhost` en développement. En
`file://` ou en HTTP simple, l'application fonctionne mais ne notifie pas, et
le navigateur n'affiche aucune erreur pour le signaler.

### La version audio

Un bouton « Écouter le brief » sous l'édito lance la lecture à voix haute par
la synthèse vocale du navigateur. Un lecteur flottant permet de mettre en
pause, de sauter d'un article à l'autre et de régler la vitesse ; l'article en
cours est mis en évidence et suit le défilement.

Deux particularités de Chrome dictent la forme du code dans `LECTEUR` :

- Il **interrompt un énoncé qui dépasse une quinzaine de secondes**. Le texte
  est donc découpé en fragments de 200 caractères au plus, de préférence sur
  une ponctuation faible, à défaut entre deux mots — une phrase peut être
  longue sans contenir la moindre virgule.
- Il **suspend la synthèse au bout d'un moment**, sans raison apparente. Un
  appel périodique à `resume()` la relance ; c'est le contournement admis.

**La limite qu'aucun contournement ne lève : la lecture s'arrête quand l'écran
se verrouille.** L'application demande un verrou d'écran (`wakeLock`) pendant
la lecture, ce qui suffit pour un téléphone posé sur un support de voiture,
au prix de la batterie. Une écoute écran éteint supposerait de vrais fichiers
audio, générés chaque soir par un service de synthèse — donc payants.

La qualité de la voix dépend entièrement de l'appareil. L'application
privilégie les voix françaises distantes de Google, nettement plus naturelles
que les voix embarquées.

---

## La passerelle d'accès

**Déployée** sur `https://brief.jamet-aymeric-pro.workers.dev`.
`index.html` ne contient plus aucun jeton.

### Deux chemins vers Airtable, deux jetons

La passerelle ne couvre que la **lecture** : c'est le chemin des abonnés,
app → Worker → Airtable, et son jeton vit dans les secrets Cloudflare.

L'**écriture** ne passe pas par elle. `publication.yml` tourne sur un runner
GitHub, qui a un accès réseau complet et appelle `api.airtable.com` en direct ;
le Worker n'expose d'ailleurs aucune route d'écriture pour les éditions. Ce
chemin-là exige donc le secret GitHub `AIRTABLE_TOKEN`.

Les scripts n'ont **aucun jeton de repli** : sans variable d'environnement, ils
s'arrêtent avec un message explicite. Un jeton écrit dans le dépôt survivrait à
sa révocation dans l'historique de git, et ferait surtout passer une
configuration absente pour une configuration correcte.

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
   | Secret | `VAPID_JWK` | la clé privée, produite par `generer_vapid.py` |
   | Secret | `DIFFUSION_SECRET` | une chaîne aléatoire, partagée avec GitHub |
   | Text | `VAPID_PUBLIC` | la clé publique, produite par `generer_vapid.py` |
   | Text | `BASE_ID` | `appzxFhyARS0LjDFc` |
   | Text | `ORIGINES` | `https://filedn.com` |

   Les clés VAPID se génèrent une fois pour toutes :

   ```bash
   python scripts/generer_vapid.py
   ```

   **Elles ne se régénèrent pas à la légère** : changer de clé publique
   invalide tous les abonnements déjà enregistrés, et chaque lecteur devrait
   réactiver les notifications.

   `DIFFUSION_SECRET` doit aussi être déclaré côté GitHub — *Settings →
   Secrets and variables → Actions* — sous le même nom : c'est lui qui autorise
   le workflow de publication à déclencher l'envoi. Sans lui, la publication se
   fait normalement mais aucune notification ne part, et le workflow le signale.

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
veille.jsonl                        titres seuls — ce que Claude lit, réécrit chaque soir
veille/
  2026-08-11.json                   résumés et URL, servis à la demande, jamais écrasés
editions/
  _modele.json                      le format documenté champ par champ
  2026/                             les éditions parues, rangées par année
    2026-08-08.json
    2026-08-10.json
scripts/
  airtable.py                       client Airtable partagé
  setup_airtable.py                 crée le schéma (idempotent)
  seed_acces.py                     jetons de test et réglages (idempotent)
  fetch_news.py                     collecte RSS
  depeches.py                       sert les résumés des dépêches demandées
  push_edition.py                   publication (upsert)
  verifier_edition.py               contrôle de cohérence
  generer_icones.py                 icônes PNG, sans dépendance
.claude/
  commands/brief-du-soir.md         la procédure et les règles éditoriales
  launch.json                       serveur local pour la prévisualisation
.github/workflows/
  collecte.yml                      16h00 · dépose la veille et rend compte
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
