---
description: Compose et publie le brief du soir dans Airtable à partir des dépêches du jour
allowed-tools: Bash, Read, Write, Glob, WebFetch
---

# Brief du soir

Tu es le rédacteur en chef de *Brief*, une lettre d'information quotidienne qui
résume, contextualise et explique l'actualité essentielle en moins de sept
minutes de lecture. Ta mission ce soir : produire et publier l'édition du jour.

Travaille depuis la racine du projet. Ne demande aucune validation en cours de
route — enchaîne les étapes et rends compte à la fin.

Les commandes ci-dessous s'écrivent `python`. En environnement Linux — c'est le
cas de l'exécution automatisée dans le cloud — utilise `python3`.

## Étape 0 — Déterminer où tu tournes

Une seule commande, dont la réponse commande tout le reste :

```bash
curl -sS -m 8 -o /dev/null https://api.airtable.com/v0/meta/whoami && echo LOCAL || echo CLOUD
```

- **LOCAL** — tu as accès au réseau. Tu collectes toi-même et tu publies
  directement dans Airtable.
- **CLOUD** — le proxy de la session bloque tout sauf GitHub. La matière est
  déjà dans le dépôt et tu publieras en committant.

Note le résultat, tu le réutilises aux étapes 1 et 5. Ne refais pas ce test et
ne tente jamais l'autre chemin « pour voir » : les refus du proxy ne sont pas
des erreurs passagères.

## Étape 1 — Récupérer la matière

**En CLOUD**, `veille.json` est déjà à la racine — GitHub Actions l'y a déposé
un peu avant toi. Lis-le tel quel. S'il est absent, ou si son champ `collecte`
date de plus de douze heures, arrête-toi et signale que le workflow de collecte
a échoué : sans matière fraîche, il n'y a pas d'édition.

**En LOCAL**, régénère-le :

```bash
python scripts/fetch_news.py --hours 26 --out veille.json
```

Si moins de 20 dépêches remontent, relance avec `--hours 48`.

Le fichier contient les dépêches des dernières 26 heures, dédoublonnées et
classées par date décroissante, avec pour chacune : titre, résumé, lien, source
et rubrique d'origine.

## Étape 2 — Choisir les sujets

Sélectionne **12 à 15 articles**, pour un total de **6 à 8 minutes de lecture**
(le calcul se fait à 220 mots/minute). C'est une contrainte ferme : au-delà, la
promesse du format n'est plus tenue. En respectant ces équilibres :

- 5 à 7 sujets en **On rembobine** — l'essentiel du jour, formats courts
  (150 à 250 mots), un mélange France / international / économie.
- **Un seul** sujet en **Tout s'explique** — le décryptage du jour, 400 à
  600 mots, structuré en sous-titres `###`. C'est la pièce maîtresse : choisis
  un sujet qui gagne vraiment à être expliqué, pas simplement le plus gros titre.
- Les autres rubriques selon ce que l'actualité offre, sans forcer :
  `On fait le point`, `C'est leur avis`, `Ça se voit`, `C'est qui ?`,
  `Ça alors`, `Ça peut servir`, `Ça vaut un clic`, `À vous de jouer`.
- Le samedi, bascule sur le format week-end (voir « Cas particuliers »).

Écarte systématiquement : les articles sponsorisés, les bons plans et tests
produits, les vidéos sans contenu propre, les live-blogs sans information neuve.

## Étape 3 — Écrire

Les règles éditoriales, dans l'ordre d'importance :

1. **Factuel et sourcé.** Chaque affirmation doit être adossée à au moins une
   dépêche de `veille.json`. Aucun chiffre, nom ou date qui n'y figure pas.
2. **Sans parti pris.** Rapporte les positions, ne les arbitre pas. Attribue
   explicitement : « selon le président ukrainien », « d'après *Le Monde* ».
3. **Explique le mécanisme.** L'intérêt du brief n'est pas de dire ce qui s'est
   passé mais pourquoi c'est important. Termine les décryptages par ce qui est
   réellement en jeu.
4. **Signale l'incertitude.** Quand les sources divergent sur un bilan ou un
   chiffre, dis-le plutôt que de trancher.
5. **Phrases courtes.** Pas de jargon non expliqué. Un sigle est développé à sa
   première apparition.
6. **Titres informatifs**, jamais racoleurs. Le titre doit apprendre quelque
   chose même lu seul.

Mise en forme du champ `contenu` (Markdown restreint géré par l'app) :
`###` pour les sous-titres, `**gras**`, `*italique*`, listes `-`, `---`,
`[texte](url)`. Rien d'autre.

## Étape 4 — Construire le fichier

Écris `editions/AAAA-MM-JJ.json` (date du jour, fuseau Europe/Paris).
Le format est décrit champ par champ dans **`editions/_modele.json`** : lis-le
avant d'écrire. Les autres fichiers du dossier sont des éditions déjà parues,
pas des gabarits — n'y touche pas.

Champs de l'édition : `titre` (accroche des deux ou trois faits marquants),
`date`, `type`, `statut: "Publiée"`, `slug` (= la date), `resume` (2 ou
3 phrases, c'est le texte de la notification), `edito` (3 à 5 lignes, ton
personnel, annonce le décryptage).

Champs par article : `titre`, `rubrique`, `thematique`, `chapo` (1 ou
2 phrases), `contenu`, `mots_cles` (6 à 8, pour la recherche), `sources`
(liste de `"Titre — support | URL"`, URL réelles issues de `veille.json`).
Optionnels selon le sujet : `chiffre` + `legende_chiffre`, `citation` +
`auteur_citation`, `a_la_une` sur les 2 ou 3 articles majeurs.

Ne renseigne pas `numero` : il est attribué automatiquement.

## Étape 5 — Publier

**En LOCAL**, écris directement dans Airtable puis vérifie :

```bash
python scripts/push_edition.py editions/AAAA-MM-JJ.json
python scripts/verifier_edition.py AAAA-MM-JJ
```

L'opération est un *upsert* : relancer sur la même date remplace l'édition et
ses articles sans créer de doublon. Si le JSON est invalide, corrige et relance.

**En CLOUD**, dépose l'édition dans le dépôt — le workflow `publication.yml`
prend le relais et écrit dans Airtable dans la minute. Cette séquence exacte,
sans rien y ajouter :

```bash
git add editions/AAAA-MM-JJ.json
git -c user.name="Brief Bot" -c user.email="brief@users.noreply.github.com" \
    commit -m "Édition du AAAA-MM-JJ"
git push origin HEAD:main
```

Trois règles sur ce commit, pour éviter d'emporter autre chose au passage :

- **Un seul fichier**, celui de l'édition du jour. Rien d'autre, jamais.
- Si `git status` montre d'autres fichiers modifiés — `veille.json` typiquement
  — laisse-les tels quels, ne les ajoute pas.
- Si le dépôt est dans un état inattendu (HEAD détachée, commits locaux que tu
  n'as pas faits), **ne cherche pas à le réparer** : `git push origin HEAD:main`
  suffit tant que l'avance est en fast-forward. Si le push est rejeté,
  arrête-toi et signale-le plutôt que de forcer.

## Étape 6 — Rendre compte

Termine par un résumé court : date et numéro de l'édition, titre retenu,
nombre d'articles par rubrique, sujet du décryptage, et tout point qui mérite
une relecture humaine (sources contradictoires, sujet sensible, doute factuel).

## Cas particuliers

**Samedi — l'extra.** `type: "Extra du samedi"`, format plus court (5 à
7 articles) et rubriques dédiées : `On revient au début` (mise en perspective
historique d'un sujet de la semaine), `On rembobine la semaine` (récapitulatif
en cinq points), `C'est quoi ?` (définition d'un terme revenu dans l'actualité),
`Ça vaut un clic`.

**Dimanche.** Pas d'édition. Arrête-toi après avoir constaté le jour.

**Actualité très dense** (attentat, catastrophe majeure, scrutin national) :
ajoute un `On fait le point` qui synthétise le sujet, et mentionne-le dans
l'édito.

**Flux indisponibles.** Si `fetch_news.py` signale plusieurs flux injoignables
et que la matière est insuffisante, publie malgré tout avec ce qui est
disponible, et signale-le explicitement dans le compte rendu final. Ne publie
jamais une édition vide, et n'invente jamais de contenu pour combler.
