/**
 * Brief — passerelle d'accès à Airtable.
 *
 * Ce Worker existe pour une raison : le jeton Airtable ne doit plus se trouver
 * dans une page publique. Il le détient seul, et n'expose au navigateur qu'un
 * petit nombre d'opérations utiles à la lecture du brief.
 *
 * Ce n'est volontairement pas un relais transparent. Un relais qui accepterait
 * n'importe quelle requête Airtable déplacerait le problème sans le résoudre :
 * l'adresse du Worker rouvrirait la base entière. Ici, chaque route renvoie
 * exactement ce qu'il faut, et rien d'autre — la table Clients, en particulier,
 * n'est jamais exposée : elle ne sert qu'à valider un jeton côté serveur.
 *
 * Configuration attendue (onglet Settings du Worker) :
 *
 *   Secrets           AIRTABLE_TOKEN    le jeton Airtable
 *                     SESSION_SECRET    une longue chaîne aléatoire, au choix
 *                     DIFFUSION_SECRET  partagé, autorise /diffuser et /publier
 *                     VAPID_JWK         clé privée des notifications
 *   Variables         BASE_ID           appzxFhyARS0LjDFc
 *                     ORIGINES          les origines autorisées, séparées par
 *                                       des virgules
 *                     VAPID_PUBLIC      clé publique des notifications
 *                     CONTACT           mailto:… facultatif, pour VAPID
 */

const TABLES = {
  reglages: "tbl0n9LTnbmLWArwu",
  editions: "tbl3iBc69xGDR5Sg8",
  articles: "tblBCSPDzwOWv1oMn",
  clients:  "tbl7g2e6qkj89IApu",
  push:     "tblD3A0snPC239bgo",
  journal:  "tblKOTUxKjS6IgOOj",
};

// Durée de vie d'une session. C'est le délai maximal entre une révocation
// dans Airtable et la perte effective de l'accès.
const DUREE_SESSION = 60 * 60;   // une heure

/**
 * Où `/publier` va chercher les dépêches du jour.
 *
 * La rédaction cite des identifiants — « lm042 » — et non des URL, pour que
 * les adresses ne traversent jamais le contexte du rédacteur. Le fichier
 * `veille/AAAA-MM-JJ.json` du dépôt public fait la correspondance. Un Worker
 * n'a ni disque ni dépôt : il le lit par HTTP, et se contente des sources
 * telles quelles s'il ne le trouve pas.
 */
const VEILLE_BASE = "https://raw.githubusercontent.com/Yosane1/Brief/main/veille";

// ───────────────────────────────────────────────────────────────────────────
// Entrée
// ───────────────────────────────────────────────────────────────────────────

export default {
  async fetch(requete, env) {
    const url = new URL(requete.url);
    const origine = enTeteOrigine(requete, env);

    if (requete.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origine) });
    }

    try {
      const reponse = await router(requete, env, url);
      for (const [k, v] of Object.entries(cors(origine))) {
        reponse.headers.set(k, v);
      }
      return reponse;
    } catch (e) {
      return json({ erreur: e.message || "Erreur interne" },
                  e.statut || 500, cors(origine));
    }
  },
};

async function router(requete, env, url) {
  const chemin = url.pathname.replace(/\/+$/, "") || "/";
  const methode = requete.method;

  // — Routes publiques ————————————————————————————————————————————
  if (chemin === "/" && methode === "GET") return diagnostic(env);

  // Une configuration incomplète produit sinon un « Airtable 404 » opaque :
  // autant nommer précisément ce qui manque.
  const manquants = ["AIRTABLE_TOKEN", "SESSION_SECRET", "BASE_ID"]
    .filter(v => !env[v]);
  if (manquants.length) {
    throw erreur(
      `Configuration incomplète : ${manquants.join(", ")} non défini(s). `
      + `À renseigner dans Settings → Variables and Secrets.`, 500);
  }

  if (chemin === "/reglages" && methode === "GET") return reglages(env);
  if (chemin === "/vapid" && methode === "GET") {
    return json({ cle: env.VAPID_PUBLIC || null });
  }
  if (chemin === "/connexion" && methode === "POST") return connexion(requete, env);

  // Diffusion et publication : appelées par le pipeline du soir, jamais par un
  // lecteur. Elles s'authentifient par un secret partagé plutôt que par une
  // session — il n'y a pas d'abonné derrière, seulement une machine.
  if (chemin === "/diffuser" && methode === "POST") return diffuser(requete, env);
  if (chemin === "/publier"  && methode === "POST") return publier(requete, env);

  // — Routes authentifiées ————————————————————————————————————————
  const session = await verifierSession(requete, env);

  switch (chemin + " " + methode) {
    case "/editions GET":    return editions(env);
    case "/edition GET":     return edition(env, url.searchParams.get("slug"));
    case "/articles GET":    return articles(env, url.searchParams);
    case "/vivier GET":      return vivier(env);
    case "/journal POST":    return journal(requete, env, session);
    case "/abonnement POST": return abonnement(requete, env, session);
    case "/sujets POST":     return sujets(requete, env, session);
    case "/lues POST":       return lues(requete, env, session);
    case "/gardes POST":     return gardes(requete, env, session);
  }
  throw erreur(`Route inconnue : ${methode} ${chemin}`, 404);
}

/**
 * État de la configuration, sans jamais révéler une valeur : seule la présence
 * de chaque réglage est rapportée, plus un appel réel à Airtable pour vérifier
 * que le couple jeton / base fonctionne.
 */
async function diagnostic(env) {
  const config = {
    AIRTABLE_TOKEN: env.AIRTABLE_TOKEN ? "défini" : "MANQUANT",
    SESSION_SECRET: env.SESSION_SECRET ? "défini" : "MANQUANT",
    BASE_ID: env.BASE_ID || "MANQUANT",
    ORIGINES: env.ORIGINES || "(toutes)",
  };

  /**
   * Les trois réglages de la diffusion, rapportés à part.
   *
   * Ils manquaient au diagnostic, ce qui rendait la panne muette : `/diffuser`
   * répond 401 aussi bien pour un secret erroné que pour un secret absent, et
   * rien ne permettait de distinguer les deux sans essayer. Présence seulement,
   * jamais la valeur.
   *
   * À part, et non dans `config`, parce qu'ils ne conditionnent pas la lecture
   * du brief : une passerelle qui sert l'édition sans savoir l'annoncer n'est
   * pas « incomplète », elle est muette. Les deux états méritent des mots
   * différents.
   */
  const diffusion = {
    DIFFUSION_SECRET: env.DIFFUSION_SECRET ? "défini" : "MANQUANT",
    VAPID_JWK: env.VAPID_JWK ? "défini" : "MANQUANT",
    VAPID_PUBLIC: env.VAPID_PUBLIC ? "défini" : "MANQUANT",
  };

  let airtableEtat = "non testé";
  if (env.AIRTABLE_TOKEN && env.BASE_ID) {
    try {
      const r = await fetch(
        `https://api.airtable.com/v0/${env.BASE_ID}/${TABLES.reglages}?maxRecords=1`,
        { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
      airtableEtat = r.ok ? "ok" : `échec ${r.status} — ${(await r.text()).slice(0, 120)}`;
    } catch (e) {
      airtableEtat = "injoignable : " + e.message;
    }
  }

  const pret = !Object.values(config).includes("MANQUANT") && airtableEtat === "ok";
  const annonce = !Object.values(diffusion).includes("MANQUANT");
  return json({
    service: "brief",
    etat: pret ? "ok" : "configuration incomplète",
    config,
    airtable: airtableEtat,
    diffusion: annonce ? "ok" : "incomplète — aucune notification ne partira",
    reglagesDiffusion: diffusion,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Airtable — jamais exposé tel quel au navigateur
// ───────────────────────────────────────────────────────────────────────────

/**
 * Une écriture accessoire : elle ne doit pas faire échouer la requête du
 * lecteur, mais son échec doit se voir.
 *
 * Trois écritures étaient jusqu'ici avalées par un `catch` muet — l'horodatage
 * de connexion, le compteur de connexions, l'état des notifications. Le jeton
 * du Worker a perdu le droit d'écrire dans la table Clients un 12 août à 13h,
 * et rien ne l'a signalé : les connexions ont cessé d'être enregistrées pendant
 * des heures sans qu'aucune réponse ne change. Un échec silencieux ressemble
 * exactement à un succès, ce qui en fait le pire des deux.
 *
 * Le message part dans les journaux Cloudflare, visibles par `wrangler tail`.
 */
function tolerer(promesse, quoi) {
  return promesse.catch(e => {
    console.warn(`[écriture ignorée] ${quoi} : ${e?.message || e}`);
  });
}

async function airtable(env, table, params = {}, options = {}) {
  const url = new URL(`https://api.airtable.com/v0/${env.BASE_ID}/${TABLES[table]}`);
  for (const [k, v] of Object.entries(params)) {
    Array.isArray(v) ? v.forEach(x => url.searchParams.append(k, x))
                     : url.searchParams.set(k, v);
  }
  const r = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) {
    // 200 caractères et non 160 : les refus de publication nomment le champ
    // fautif en fin de message, et la troncature les coupait juste avant.
    const detail = await r.text().catch(() => "");
    throw erreur(`Airtable ${r.status} : ${detail.slice(0, 200)}`, 502);
  }
  return r.json();
}

async function tout(env, table, params = {}) {
  let sortie = [], offset;
  do {
    const p = { ...params, pageSize: 100 };
    if (offset) p.offset = offset;
    const rep = await airtable(env, table, p);
    sortie = sortie.concat(rep.records);
    offset = rep.offset;
  } while (offset);
  return sortie;
}

const echapper = v => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* Écritures par lots de dix, la limite de l'API Airtable.
 *
 * Ces trois-là échouent bruyamment, à la différence de `majLot` plus bas : une
 * publication à moitié écrite doit s'arrêter et le dire. La distinction n'est
 * pas cosmétique — c'est exactement la leçon du 12 août, où des écritures
 * avalées ont fait passer une panne de quatre heures pour un fonctionnement
 * normal. Une écriture accessoire se tolère, une écriture d'édition non. */

async function creerLots(env, table, lignes) {
  const faits = [];
  for (let i = 0; i < lignes.length; i += 10) {
    const res = await airtable(env, table, {}, {
      method: "POST",
      body: { records: lignes.slice(i, i + 10).map(fields => ({ fields })),
              typecast: true },
    });
    faits.push(...(res.records || []));
  }
  return faits;
}

async function majLots(env, table, lignes) {
  const faits = [];
  for (let i = 0; i < lignes.length; i += 10) {
    const res = await airtable(env, table, {}, {
      method: "PATCH",
      body: { records: lignes.slice(i, i + 10), typecast: true },
    });
    faits.push(...(res.records || []));
  }
  return faits;
}

async function supprimerLots(env, table, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const url = new URL(`https://api.airtable.com/v0/${env.BASE_ID}/${TABLES[table]}`);
    ids.slice(i, i + 10).forEach(id => url.searchParams.append("records[]", id));
    const r = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw erreur(`Airtable DELETE ${r.status} : ${detail.slice(0, 200)}`, 502);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Sessions signées (HMAC-SHA256)
// ───────────────────────────────────────────────────────────────────────────

const b64url = octets => btoa(String.fromCharCode(...new Uint8Array(octets)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const deB64url = s => Uint8Array.from(
  atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function cle(env) {
  if (!env.SESSION_SECRET) throw erreur("SESSION_SECRET non configuré", 500);
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signer(env, charge) {
  const corps = b64url(new TextEncoder().encode(JSON.stringify(charge)));
  const sig = await crypto.subtle.sign("HMAC", await cle(env),
                                       new TextEncoder().encode(corps));
  return `${corps}.${b64url(sig)}`;
}

async function verifierSession(requete, env) {
  const brut = (requete.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!brut || !brut.includes(".")) throw erreur("Session absente", 401);

  const [corps, sig] = brut.split(".");
  const valide = await crypto.subtle.verify(
    "HMAC", await cle(env), deB64url(sig), new TextEncoder().encode(corps));
  if (!valide) throw erreur("Session invalide", 401);

  const charge = JSON.parse(new TextDecoder().decode(deB64url(corps)));
  if (charge.exp < Math.floor(Date.now() / 1000)) throw erreur("Session expirée", 401);
  return charge;
}

// ───────────────────────────────────────────────────────────────────────────
// Contrôle d'accès
// ───────────────────────────────────────────────────────────────────────────

async function connexion(requete, env) {
  const { identifiant = "", jeton = "", appareil = "" } =
    await requete.json().catch(() => ({}));
  const login = String(identifiant).trim().toLowerCase();
  const propre = String(jeton).trim().toUpperCase();

  if (!login) throw erreur("Saisissez votre identifiant.", 400);
  if (!propre) throw erreur("Saisissez votre mot de passe.", 400);

  // L'identifiant est l'adresse e-mail, ou le champ Identifiant s'il est
  // renseigné — ce qui permet un login qui ne soit pas une adresse.
  const trouves = await tout(env, "clients", {
    filterByFormula: `AND(
      UPPER(TRIM({Jeton})) = '${echapper(propre)}',
      OR(
        LOWER(TRIM({Email})) = '${echapper(login)}',
        LOWER(TRIM({Identifiant})) = '${echapper(login)}'
      ))`.replace(/\s+/g, " "),
    maxRecords: 1,
  });

  // Message unique, quelle que soit la partie fausse : distinguer « identifiant
  // inconnu » de « mot de passe incorrect » révélerait quels comptes existent.
  if (!trouves.length) {
    await tracer(env, null, login, "Échec connexion", "Couple invalide", appareil);
    throw erreur("Identifiant ou mot de passe incorrect.", 403);
  }

  const f = trouves[0].fields;
  const nom = f["Nom"] || "Abonné";
  const jour = new Date().toISOString().slice(0, 10);
  const refus =
    !f["Actif"] ? `L'accès « ${nom} » a été désactivé. Contactez-nous pour le réactiver.`
    : f["Date début"] && jour < f["Date début"]
      ? `Cet abonnement ne démarre que le ${enFrancais(f["Date début"])}.`
    : f["Date fin"] && jour > f["Date fin"]
      ? `Cet abonnement a expiré le ${enFrancais(f["Date fin"])}. Renouvelez-le pour retrouver l'accès.`
    : null;

  // Le journal enregistre l'identifiant, jamais le mot de passe.
  if (refus) {
    await tracer(env, trouves[0].id, login, "Échec connexion", refus, appareil);
    throw erreur(refus, 403);
  }

  // Limite de postes, pour les abonnements non illimités.
  const places = f["Places"] || 0;
  if (!f["Utilisateurs illimités"] && places > 0 && appareil) {
    const passages = await tout(env, "journal", {
      filterByFormula: `AND({Jeton saisi} = '${echapper(login)}', {Type} = 'Connexion')`,
      "fields[]": ["Appareil"],
    });
    const connus = new Set(passages.map(r => r.fields["Appareil"]).filter(Boolean));
    if (!connus.has(appareil) && connus.size >= places) {
      const motif = `Cet abonnement autorise ${places} appareil(s) et la limite est atteinte.`;
      await tracer(env, trouves[0].id, login, "Échec connexion", motif, appareil);
      throw erreur(motif, 403);
    }
  }

  // Le client ne reçoit que son propre profil, jamais la table.
  const profil = {
    nom,
    email: f["Email"] || "",
    plan: f["Plan"] || "",
    role: f["Rôle"] || "Lecteur",
    fin: f["Date fin"] || null,
    illimite: !!f["Utilisateurs illimités"],
    places,
    notifications: !!f["Notifications"],
    // Les sujets suivis voyagent avec le profil : la lecture ne coûte donc
    // aucun appel supplémentaire, et l'abonné retrouve sa veille sur n'importe
    // lequel de ses appareils. Les éditions lues suivent le même chemin.
    sujets: listeSujets(f["Sujets suivis"]),
    lues: listeLues(f["Editions lues"]),
    gardes: listeGardes(f["Articles gardés"]),
  };

  const maintenant = Math.floor(Date.now() / 1000);
  const session = await signer(env, {
    c: trouves[0].id,
    n: nom,
    exp: maintenant + DUREE_SESSION,
  });

  await tolerer(airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: trouves[0].id, fields: {
      "Dernière connexion": new Date().toISOString(),
      "Connexions": (f["Connexions"] || 0) + 1,
    }}], typecast: true },
  }), "horodatage de connexion");

  await tracer(env, trouves[0].id, login, "Connexion", appareil, appareil);

  return json({ session, profil, expire: maintenant + DUREE_SESSION });
}

// ───────────────────────────────────────────────────────────────────────────
// Contenus — uniquement ce qui est publié
// ───────────────────────────────────────────────────────────────────────────

async function reglages(env) {
  const recs = await tout(env, "reglages");
  return json(Object.fromEntries(
    recs.filter(r => r.fields["Clé"])
        .map(r => [r.fields["Clé"], (r.fields["Valeur"] ?? "").trim()])));
}

async function editions(env) {
  const recs = await tout(env, "editions", {
    filterByFormula: "{Statut} = 'Publiée'",
    "sort[0][field]": "Date",
    "sort[0][direction]": "desc",
  });
  return json(recs.map(r => ({
    id: r.id,
    date: r.fields["Date"],
    slug: r.fields["Slug"] || r.fields["Date"],
    titre: r.fields["Titre"] || "Édition du jour",
    numero: r.fields["Numéro"],
    type: r.fields["Type"] || "Quotidienne",
    resume: r.fields["Résumé"] || "",
    edito: r.fields["Édito"] || "",
    minutes: r.fields["Temps de lecture"] || null,
    image: r.fields["Image de une"] || "",
    credit: r.fields["Crédit image"] || "",
  })).filter(e => e.date));
}

async function edition(env, slug) {
  if (!slug) throw erreur("Slug manquant", 400);
  const trouvees = await tout(env, "editions", {
    filterByFormula: `AND({Slug} = '${echapper(slug)}', {Statut} = 'Publiée')`,
    maxRecords: 1,
  });
  if (!trouvees.length) throw erreur("Édition introuvable", 404);

  // DATESTR est indispensable : comparer un champ date à une chaîne avec « = »
  // ne renvoie jamais rien côté Airtable.
  const recs = await tout(env, "articles", {
    filterByFormula: `DATESTR({Date}) = '${echapper(trouvees[0].fields["Date"])}'`,
    "sort[0][field]": "Ordre",
    "sort[0][direction]": "asc",
  });
  return json({ articles: recs.map(article) });
}

async function articles(env, params) {
  const q = (params.get("q") || "").trim().toLowerCase();
  const conditions = [];

  if (q) {
    const t = echapper(q);
    conditions.push(`OR(${[
      `SEARCH('${t}', LOWER({Titre} & ''))`,
      `SEARCH('${t}', LOWER({Chapô} & ''))`,
      `SEARCH('${t}', LOWER({Contenu} & ''))`,
      `SEARCH('${t}', LOWER({Mots-clés} & ''))`,
    ].join(",")})`);
  }
  for (const [cle, champ] of [["rubrique", "Rubrique"], ["thematique", "Thématique"]]) {
    const v = params.get(cle);
    if (v) conditions.push(`{${champ}} = '${echapper(v)}'`);
  }
  if (params.get("depuis")) conditions.push(`IS_AFTER({Date}, '${echapper(params.get("depuis"))}')`);
  if (params.get("jusqua")) conditions.push(`IS_BEFORE({Date}, '${echapper(params.get("jusqua"))}')`);
  if (!conditions.length) throw erreur("Aucun critère de recherche", 400);

  const recs = await tout(env, "articles", {
    filterByFormula: conditions.length > 1 ? `AND(${conditions.join(",")})` : conditions[0],
    "sort[0][field]": "Date",
    "sort[0][direction]": "desc",
  });
  return json(recs.map(article));
}

async function vivier(env) {
  const recs = await tout(env, "articles", {
    "fields[]": ["Titre", "Rubrique", "Thématique", "Mots-clés", "Date", "Chapô", "Image"],
    "sort[0][field]": "Date",
    "sort[0][direction]": "desc",
  });
  return json(recs.map(article));
}

/**
 * Lit les mots-clés, que le champ soit du texte ou une génération d'Airtable.
 *
 * Un champ IA ne renvoie pas une chaîne mais `{state, value, isStale}`. Tant
 * que `state` ne vaut pas « generated », on renvoie une liste vide : l'article
 * paraît sans étiquettes plutôt que de faire échouer toute l'édition sur une
 * automatisation annexe.
 */
function motsClesDe(champ) {
  const brut = champ && typeof champ === "object"
    ? (champ.state === "generated" ? champ.value : "")
    : champ;
  return String(brut || "").split(",").map(s => s.trim()).filter(Boolean);
}

function article(r) {
  const f = r.fields;
  return {
    id: r.id,
    titre: f["Titre"] || "",
    rubrique: f["Rubrique"] || "On rembobine",
    thematique: f["Thématique"] || "",
    chapo: f["Chapô"] || "",
    contenu: f["Contenu"] || "",
    chiffre: f["Chiffre clé"] || "",
    legendeChiffre: f["Légende chiffre"] || "",
    citation: f["Citation"] || "",
    auteurCitation: f["Auteur citation"] || "",
    image: f["Image"] || "",
    legendeImage: f["Légende image"] || "",
    sources: (f["Sources"] || "").split("\n").filter(Boolean).map(l => {
      const [titre, url] = l.split("|").map(s => (s || "").trim());
      return { titre: titre || url, url: url || "" };
    }),
    motsCles: motsClesDe(f["Mots-clés"]),
    date: f["Date"] || "",
    ordre: f["Ordre"] || 0,
    aLaUne: !!f["À la une"],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Écritures autorisées
// ───────────────────────────────────────────────────────────────────────────

async function journal(requete, env, session) {
  const { type = "Lecture", detail = "", appareil = "" } = await requete.json().catch(() => ({}));
  await tracer(env, session.c, "", type, detail, appareil, session.n);
  return json({ ok: true });
}

/**
 * Les sujets suivis d'un abonné.
 *
 * Rangés dans le champ « Sujets suivis » de la table Clients, séparés par des
 * virgules. C'est le seul endroit qui suive l'abonné plutôt que l'appareil :
 * une liste gardée dans le navigateur divergeait d'un téléphone à un ordinateur
 * sans jamais se réconcilier.
 *
 * L'enregistrement visé vient de `session.c`, c'est-à-dire de la charge signée
 * en HMAC — jamais du corps de la requête. Un lecteur ne peut donc écrire que
 * ses propres sujets, même en fabriquant l'appel à la main.
 */
function listeSujets(brut) {
  return String(brut || "")
    .split(",").map(s => s.trim()).filter(Boolean).slice(0, 30);
}

async function sujets(requete, env, session) {
  const recu = await requete.json().catch(() => ({}));
  if (!Array.isArray(recu.sujets)) throw erreur("Liste de sujets attendue", 400);

  // On borne ce qui est écrit : un mot-clé est court, et trente sujets suivis
  // couvrent déjà bien au-delà de ce qu'un lecteur surveille.
  const propres = [...new Set(recu.sujets
    .map(s => String(s).trim().replace(/,/g, " "))   // la virgule est le séparateur
    .filter(s => s && s.length <= 60))].slice(0, 30);

  await airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: session.c, fields: { "Sujets suivis": propres.join(", ") } }],
            typecast: true },
  });

  return json({ ok: true, sujets: propres });
}

/**
 * Les éditions déjà lues.
 *
 * Même dispositif que les sujets suivis, et pour la même raison : l'état de
 * lecture appartient à l'abonné, pas au navigateur qui l'a enregistré. Sans
 * cela, une édition lue le midi sur l'ordinateur se represente le soir sur le
 * téléphone comme si elle était neuve.
 *
 * Rangé dans le champ « Editions lues » de la table Clients, dates séparées
 * par des virgules. Le format est volontairement pauvre : il se relit à l'œil
 * dans Airtable, et se répare à la main le jour où il le faudrait.
 */
function listeLues(brut) {
  return String(brut || "")
    .split(",").map(s => s.trim()).filter(Boolean).slice(-400);
}

async function lues(requete, env, session) {
  const recu = await requete.json().catch(() => ({}));
  if (!Array.isArray(recu.lues)) throw erreur("Liste d'éditions attendue", 400);

  // Un slug d'édition est une date, ou s'y ramène. On borne à quatre cents,
  // soit treize mois de quotidiennes — au-delà, les plus anciennes sortent,
  // exactement comme le fait la copie locale.
  const propres = [...new Set(recu.lues
    .map(s => String(s).trim())
    .filter(s => /^[0-9A-Za-z_-]{1,40}$/.test(s)))].slice(-400);

  await airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: session.c, fields: { "Editions lues": propres.join(", ") } }],
            typecast: true },
  });

  return json({ ok: true, lues: propres });
}

/**
 * Les articles mis de côté.
 *
 * Ils voyagent en JSON, et non en liste séparée par des virgules comme les
 * éditions lues : un gardé n'est pas un identifiant mais une petite fiche —
 * titre, date, rubrique, chapô — que la vue affiche sans avoir à charger
 * l'édition. C'est ce qui la rend lisible hors ligne, et une collection qu'on
 * met des mois à constituer ne doit pas dépendre de ce qui traîne en cache.
 *
 * Un champ illisible ne fait pas échouer la connexion : on rend une liste vide
 * et la copie locale du lecteur reprend la main au premier changement.
 */
function listeGardes(brut) {
  try {
    const t = JSON.parse(brut || "[]");
    return Array.isArray(t) ? t.slice(0, 200) : [];
  } catch {
    return [];
  }
}

async function gardes(requete, env, session) {
  const recu = await requete.json().catch(() => ({}));
  if (!Array.isArray(recu.gardes)) throw erreur("Liste d'articles attendue", 400);

  // Chaque champ est borné à la longueur qui sert à l'affichage : sans cela,
  // deux cents chapôs entiers dépasseraient la capacité du champ Airtable, et
  // rien n'empêcherait d'y ranger autre chose que des articles.
  const propres = recu.gardes
    .filter(g => g && typeof g === "object" &&
                 /^rec[0-9A-Za-z]{10,20}$/.test(String(g.id)))
    .slice(0, 200)
    .map(g => ({
      id: String(g.id),
      titre: String(g.titre || "").slice(0, 200),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(g.date)) ? String(g.date) : "",
      rubrique: String(g.rubrique || "").slice(0, 60),
      chapo: String(g.chapo || "").slice(0, 180),
    }));

  // Le nombre de fiches ne suffit pas à borner le poids : deux cents fiches
  // dont les titres et les chapôs seraient à leur longueur maximale pèseraient
  // 107 400 caractères, au-dessus des 100 000 d'un champ texte long. Le PATCH
  // échouerait, et la collection ne serait plus sauvegardée sans que rien ne le
  // signale. On retire donc les plus anciennes jusqu'à rentrer — exactement ce
  // que fait déjà le plafond de deux cents, mais sur le critère qui compte.
  const BUDGET = 90000;                 // marge gardée sous la limite du champ
  const tenus = [...propres];
  while (tenus.length > 1 && JSON.stringify(tenus).length > BUDGET) tenus.pop();

  await airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: session.c,
                        fields: { "Articles gardés": JSON.stringify(tenus) } }],
            typecast: true },
  });

  return json({ ok: true, gardes: tenus.length,
                ...(tenus.length < propres.length
                    ? { ecartes: propres.length - tenus.length } : {}) });
}

async function abonnement(requete, env, session) {
  const { appareil = "", active = true, description = "", souscription = null } =
    await requete.json().catch(() => ({}));
  if (!appareil) throw erreur("Identifiant d'appareil manquant", 400);

  const champs = {
    "Identifiant": appareil,
    "Client": [session.c],
    "Appareil": description.slice(0, 200),
    "Active": !!active,
    "Créé le": new Date().toISOString(),
  };

  // La souscription PushManager : c'est elle qui permet d'atteindre l'appareil
  // application fermée. Sans elle, l'enregistrement ne sert qu'au décompte.
  if (souscription?.endpoint) {
    champs["Endpoint"] = souscription.endpoint;
    champs["Clé p256dh"] = souscription.keys?.p256dh || "";
    champs["Clé auth"] = souscription.keys?.auth || "";
  }
  const existants = await tout(env, "push", {
    filterByFormula: `{Identifiant} = '${echapper(appareil)}'`, maxRecords: 1,
  });

  await airtable(env, "push", {}, existants.length
    ? { method: "PATCH", body: { records: [{ id: existants[0].id, fields: champs }], typecast: true } }
    : { method: "POST",  body: { records: [{ fields: champs }], typecast: true } });

  await tolerer(airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: session.c, fields: { "Notifications": !!active } }], typecast: true },
  }), "état des notifications");

  return json({ ok: true });
}

async function tracer(env, clientId, jeton, type, detail, appareil, nom = "") {
  const champs = {
    "Événement": `${type}${nom ? " — " + nom : ""}`.slice(0, 250),
    "Type": type,
    "Jeton saisi": String(jeton).slice(0, 60),
    "Détail": String(detail).slice(0, 250),
    "Horodatage": new Date().toISOString(),
    "Appareil": String(appareil).slice(0, 200),
  };
  if (clientId) champs["Client"] = [clientId];
  // Le journal ne doit jamais empêcher la lecture, mais son silence ne doit
  // pas non plus faire croire qu'il a enregistré.
  return tolerer(airtable(env, "journal", {}, {
    method: "POST", body: { records: [{ fields: champs }], typecast: true },
  }), `journal (${type})`);
}

// ───────────────────────────────────────────────────────────────────────────
// Publication d'une édition
//
// L'opération est un *upsert* : republier la même date remplace proprement
// l'édition et ses articles, sans doublon. C'est le pendant de
// `scripts/push_edition.py`, pour qui pousse du JSON plutôt qu'un fichier.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Table « identifiant de dépêche → { ligne, titre } » pour un jour.
 *
 * Chaque dépêche y entre sous sa clé de fichier et sous son autre forme :
 * `0815-lm001` répond à `lm001` et réciproquement. Les identifiants portent
 * leur date depuis le 17 août 2026 — les numéros repartant à 001 à chaque
 * collecte, un identifiant nu ne désigne une dépêche que tant qu'on sait de
 * quel soir il vient — mais les éditions écrites avant doivent continuer de se
 * republier telles quelles. Voir scripts/identifiants.py, qui fait de même.
 */
async function chargerLiens(date) {
  const table = {};
  const catalogue = [];
  try {
    const r = await fetch(`${VEILLE_BASE}/${date}.json`);
    if (!r.ok) return { table, catalogue };
    const brut = await r.json();
    const prefixe = date.length >= 10 ? date.slice(5, 7) + date.slice(8, 10) : "";
    for (const [id, valeur] of Object.entries(brut)) {
      const [source = "", titre = "", url = ""] = Array.isArray(valeur) ? valeur : [];
      const ligne = `${source} · ${titre} | ${url}`;
      const entree = { ligne, titre };
      const nu = id.includes("-") ? id.slice(id.indexOf("-") + 1) : id;
      // Le catalogue ne sert pas à résoudre mais à comparer : une entrée par
      // dépêche, avec de quoi la retrouver par son titre.
      catalogue.push({ id, code: nu.slice(0, -3), titre, ligne });
      for (const forme of new Set([id, nu, prefixe ? `${prefixe}-${nu}` : nu])) {
        table[forme] = entree;
      }
    }
  } catch (e) {
    // Une veille injoignable ne doit pas empêcher de publier : les sources
    // resteront sous forme d'identifiants, ce qui se répare après coup.
    console.warn(`[veille] impossible de charger ${date}.json : ${e.message}`);
  }
  return { table, catalogue };
}

// Mots outils du français : présents partout, ils ne rapprochent rien.
const MOTS_VIDES = new Set((
  "dans pour avec sans sous plus tout tous toute toutes cette leur leurs elle "
  + "mais donc alors comment pourquoi entre apres avant chez vers contre depuis "
  + "encore aussi celui ceux cela quand faire fait etre avoir vont sont ont les "
  + "des une aux qui que quoi dont ses son sur par est ete moins tres bien deja "
  + "ainsi cet ces nous vous ils elles voici voila selon"
).split(" "));

/** Les mots d'un texte qui portent du sens, accents neutralisés. */
function motsUtiles(texte) {
  return new Set(String(texte || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(m => m.length >= 4 && !MOTS_VIDES.has(m)));
}

// ── La citation : un identifiant, et l'amorce du titre qu'il désigne ──────
//
// Un identifiant nu est un numéro sans redondance : `lm003` recopié pour
// `lm001` se résout parfaitement, sur une autre dépêche, et rien ne peut le
// voir. Le 15 août 2026, trois articles de l'extra du samedi citaient ainsi le
// Liechtenstein, les réseaux sociaux et l'Euro de natation pour des sujets qui
// parlaient de Locarno, du triangle des Bermudes et du mariage avec un
// personnage de manga.
//
// D'où la citation en deux parties, `0818-lm001 · La chaîne ABC poursuit…` :
// deux chemins indépendants vers la même dépêche. Ils concordent, la source est
// prouvée ; ils divergent, le titre dit laquelle des deux moitiés a raison.
// L'erreur passe de silencieuse à réparable. Voir scripts/identifiants.py, qui
// tient le même raisonnement pour la voie en ligne de commande.

const SEPARATEURS = "·—–|";
const MOTIF_ID = /^(?:\d{4}-)?[a-z][a-z0-9]{1,3}\d{3}$/;
const SEUIL_ACCORD = 0.6;      // valider une citation
const SEUIL_CORRECTION = 0.7;  // en rétablir une, chez le même média
const SEUIL_LARGE = 0.85;      // la chercher dans toute la collecte
const ECART_MINIMAL = 0.15;    // en deçà, deux dépêches se valent : on renonce
const MOTS_SUFFISANTS = 3;     // sous ce seuil, une amorce ne prouve rien

/** « 0818-lm001 · La chaîne ABC… » → { ident, amorce }. */
function decouper(citation) {
  const texte = String(citation || "").trim();
  let tete = texte, reste = "";
  for (let i = 0; i < texte.length; i++) {
    if (SEPARATEURS.includes(texte[i])) {
      tete = texte.slice(0, i).trim();
      reste = texte.slice(i + 1).trim();
      break;
    }
  }
  // Une ligne déjà résolue commence par le nom du média, qui ne peut pas
  // passer pour un identifiant : le motif tranche sans ambiguïté.
  return MOTIF_ID.test(tete) ? { ident: tete, amorce: reste } : { ident: null, amorce: "" };
}

/** Part des mots significatifs de l'amorce qu'on retrouve dans le titre. */
function recouvrement(fragment, titre) {
  const amorce = motsUtiles(fragment);
  if (!amorce.size) return 0;
  const cible = motsUtiles(titre);
  let n = 0;
  for (const m of amorce) if (cible.has(m)) n++;
  return n / amorce.size;
}

const verifiable = fragment => motsUtiles(fragment).size >= MOTS_SUFFISANTS;

function meilleur(fragment, lot, seuil) {
  const notes = lot
    .map(e => [recouvrement(fragment, e.titre), e])
    .sort((x, y) => y[0] - x[0]);
  if (!notes.length || notes[0][0] < seuil) return null;
  if (notes.length > 1 && notes[0][0] - notes[1][0] < ECART_MINIMAL) return null;
  return notes[0][1];
}

/**
 * Retrouve la dépêche dont le titre correspond à l'amorce citée.
 *
 * L'erreur observée est toujours la même : le bon média, le mauvais numéro. Le
 * code de média est alphabétique et porte du sens, il se recopie juste ; c'est
 * le rang qui glisse. On cherche donc d'abord chez le même média, puis dans
 * toute la collecte en exigeant davantage — deux médias couvrant le même
 * événement écrivent des titres proches, et là le doute est réel.
 */
function corriger(ident, amorce, catalogue) {
  if (!verifiable(amorce)) return null;
  const nu = ident.includes("-") ? ident.slice(ident.indexOf("-") + 1) : ident;
  const code = nu.slice(0, -3);
  return meilleur(amorce, catalogue.filter(e => e.code === code), SEUIL_CORRECTION)
      || meilleur(amorce, catalogue, SEUIL_LARGE);
}

/**
 * Détend les citations, et n'écrit que ce qui est vérifié.
 *
 * Une source fausse est pire qu'une source absente : elle se lit comme une
 * caution. L'article reste parfaitement lisible sans elle, tandis qu'une
 * dépêche sans rapport affirme au lecteur quelque chose de faux sur la
 * provenance de ce qu'il vient de lire. On écarte donc, on ne se contente plus
 * de signaler — `/publier` ne vérifiait rien du tout jusqu'au 17 août 2026,
 * puis signalait sans rien retirer.
 *
 * Trois cas, du plus sûr au plus fragile :
 *
 *   • citation en deux moitiés — elles se recoupent, la source est prouvée et
 *     rien d'autre n'a à être vérifié ; elles divergent, on retrouve la dépêche
 *     par son titre et on corrige, ou on écarte ;
 *   • citation nue, héritée d'avant ce format — on retombe sur le contrôle par
 *     vocabulaire, qui ne voit que la source n'ayant aucun rapport ;
 *   • URL ou ligne déjà résolue — laissée intacte.
 */
function resoudreSources(sources, liens, catalogue, vocabulaire) {
  const rapport = { ecartees: [], corrigees: [] };
  if (!Array.isArray(sources)) return { texte: String(sources || ""), rapport };

  const lignes = [];
  for (const s of sources) {
    if (typeof s === "object" && s !== null) {
      lignes.push(`${s.titre || ""} | ${s.url || ""}`);
      continue;
    }
    const brut = String(s).trim();
    const { ident, amorce } = decouper(brut);
    if (!ident) { lignes.push(brut); continue; }

    const entree = liens[ident];

    if (verifiable(amorce)) {
      if (entree && recouvrement(amorce, entree.titre) >= SEUIL_ACCORD) {
        lignes.push(entree.ligne);
        continue;
      }
      const trouve = corriger(ident, amorce, catalogue);
      if (trouve) {
        lignes.push(trouve.ligne);
        rapport.corrigees.push({ id: ident, vers: trouve.id, depeche: trouve.titre.slice(0, 70) });
      } else {
        rapport.ecartees.push({ id: ident, motif: "le titre cité ne désigne aucune dépêche du jour" });
      }
      continue;
    }

    // Citation nue : l'amorce manque ou ne pèse pas assez pour prouver quoi
    // que ce soit. Le contrôle par vocabulaire est tout ce qui reste.
    if (!entree) {
      rapport.ecartees.push({ id: ident, motif: "absent de la veille du jour" });
    } else if (vocabulaire?.size
               && ![...motsUtiles(entree.titre)].some(m => vocabulaire.has(m))) {
      rapport.ecartees.push({ id: ident, motif: "aucun mot commun avec l'article",
                              depeche: entree.titre.slice(0, 70) });
    } else {
      lignes.push(entree.ligne);
    }
  }

  return { texte: lignes.join("\n"), rapport };
}

async function numeroSuivant(env) {
  const derniers = await tout(env, "editions", {
    "fields[]": ["Numéro"],
    "sort[0][field]": "Numéro",
    "sort[0][direction]": "desc",
    maxRecords: 1,
  });
  if (derniers.length && derniers[0].fields["Numéro"]) {
    return Number(derniers[0].fields["Numéro"]) + 1;
  }
  return 1;
}

async function publier(requete, env) {
  if (!env.DIFFUSION_SECRET ||
      requete.headers.get("X-Diffusion") !== env.DIFFUSION_SECRET) {
    throw erreur("Publication non autorisée", 401);
  }

  const charge = await requete.json().catch(() => null);
  if (!charge || !charge.edition || !Array.isArray(charge.articles)) {
    throw erreur("JSON invalide : { edition, articles } attendu", 400);
  }

  const ed = { ...charge.edition };
  const articles = charge.articles;
  const slug = ed.slug || ed.date;
  if (!slug || !ed.date) throw erreur("edition.date et edition.slug obligatoires", 400);

  ed.genere_par = ed.genere_par || "Claude (via Worker)";
  ed.statut = ed.statut || "Publiée";
  ed.type = ed.type || "Quotidienne";

  // 220 mots à la minute : la même cadence que celle annoncée au lecteur.
  if (!ed.temps_lecture) {
    const mots = articles.reduce((n, a) =>
      n + ((a.contenu || "") + " " + (a.chapo || "")).split(/\s+/).filter(Boolean).length, 0);
    ed.temps_lecture = Math.max(2, Math.round(mots / 220));
  }

  const champsEdition = {
    "Titre": ed.titre,
    "Date": ed.date,
    "Slug": slug,
    "Type": ed.type,
    "Statut": ed.statut,
    "Édito": ed.edito || "",
    "Résumé": ed.resume || "",
    "Temps de lecture": ed.temps_lecture,
    "Généré par": ed.genere_par,
  };
  if (ed.image) champsEdition["Image de une"] = ed.image;
  if (ed.credit_image) champsEdition["Crédit image"] = ed.credit_image;

  const existantes = await tout(env, "editions", {
    filterByFormula: `{Slug} = '${echapper(slug)}'`,
    maxRecords: 1,
  });

  let recId, action;
  if (existantes.length) {
    recId = existantes[0].id;
    // On ne renumérote pas une édition existante.
    await majLots(env, "editions", [{ id: recId, fields: champsEdition }]);
    action = "mise à jour";

    // DATESTR : comparer un champ date à une chaîne avec « = » ne renvoie
    // jamais rien côté Airtable.
    const anciens = await tout(env, "articles", {
      filterByFormula: `DATESTR({Date}) = '${echapper(ed.date)}'`,
      "fields[]": ["Titre"],
    });
    if (anciens.length) await supprimerLots(env, "articles", anciens.map(a => a.id));
  } else {
    champsEdition["Numéro"] = await numeroSuivant(env);
    if (ed.statut === "Publiée") {
      champsEdition["Publiée le"] = new Date().toISOString();
    }
    const crees = await creerLots(env, "editions", [champsEdition]);
    recId = crees[0].id;
    action = "créée";
  }

  const { table: liens, catalogue } = await chargerLiens(ed.date);
  const ecartees = [];
  const corrigees = [];
  const lignes = articles.map((a, i) => {
    // Le titre et le chapô suffisent à dire de quoi parle l'article ; le
    // contenu n'ajouterait que du bruit au rapprochement.
    const vocabulaire = motsUtiles(`${a.titre || ""} ${a.chapo || ""}`);
    const { texte, rapport } = resoudreSources(a.sources, liens, catalogue, vocabulaire);
    const ou = (a.titre || "").slice(0, 50);
    for (const e of rapport.ecartees) ecartees.push({ article: ou, ...e });
    for (const c of rapport.corrigees) corrigees.push({ article: ou, ...c });
    // « Mots-clés » ne figure pas ici : Airtable le génère lui-même après la
    // création de l'article, et un champ IA n'est pas inscriptible.
    const fields = {
      "Titre": a.titre || "",
      "Rubrique": a.rubrique || "On rembobine",
      "Thématique": a.thematique || "",
      "Ordre": a.ordre ?? (i + 1),
      "Chapô": a.chapo || "",
      "Contenu": a.contenu || "",
      "Date": ed.date,
      "À la une": !!a.a_la_une,
      "Édition": [recId],
      "Sources": texte,
    };
    if (a.chiffre) fields["Chiffre clé"] = String(a.chiffre);
    if (a.legende_chiffre) fields["Légende chiffre"] = a.legende_chiffre;
    if (a.citation) fields["Citation"] = a.citation;
    if (a.auteur_citation) fields["Auteur citation"] = a.auteur_citation;
    if (a.image) fields["Image"] = a.image;
    if (a.legende_image) fields["Légende image"] = a.legende_image;
    if (a.temps_lecture) fields["Temps de lecture"] = a.temps_lecture;
    return fields;
  });

  if (lignes.length) await creerLots(env, "articles", lignes);

  // Ce qui n'a pas pu être vérifié n'est pas écrit : l'édition part sans ces
  // sources-là. Elles remontent quand même dans la réponse, et non dans un
  // journal que personne ne lit — c'est tout l'objet du contrôle. Un
  // `{"ok":true}` nu avait laissé passer l'extra du 15 août 2026 sans un mot.
  const reserves = {};
  if (corrigees.length) reserves.sources_corrigees = corrigees;
  if (ecartees.length) reserves.sources_ecartees = ecartees;
  if (!Object.keys(liens).length) {
    reserves.veille = `${ed.date}.json introuvable : aucune source n'a pu être résolue`;
  }

  return json({
    ok: true,
    action,
    slug,
    edition_id: recId,
    articles: lignes.length,
    temps_lecture: ed.temps_lecture,
    statut: ed.statut,
    ...(Object.keys(reserves).length ? { reserves } : {}),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Diffusion push
//
// Deux normes se combinent ici :
//   RFC 8291 — chiffrement du contenu, pour que le service de push (Google,
//              Mozilla, Apple) relaie sans jamais pouvoir lire la notification
//   RFC 8292 — signature VAPID, qui prouve au service que l'envoi vient bien
//              du serveur déclaré lors de l'abonnement
//
// Rien de tout cela n'est optionnel : un envoi non chiffré ou non signé est
// rejeté par tous les services de push.
// ───────────────────────────────────────────────────────────────────────────

const octets = s => new TextEncoder().encode(s);

function coller(...morceaux) {
  const total = morceaux.reduce((n, m) => n + m.byteLength, 0);
  const sortie = new Uint8Array(total);
  let i = 0;
  for (const m of morceaux) { sortie.set(new Uint8Array(m), i); i += m.byteLength; }
  return sortie;
}

async function hkdf(ikm, sel, info, longueur) {
  const cle = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: sel, info }, cle, longueur * 8));
}

/** Chiffre le contenu pour un abonné donné, au format aes128gcm. */
async function chiffrer(p256dh, auth, message) {
  const clePubliqueNavigateur = deB64url(p256dh);
  const secretAuth = deB64url(auth);

  // Paire éphémère : une nouvelle à chaque notification.
  const paire = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const clePubliqueServeur = new Uint8Array(
    await crypto.subtle.exportKey("raw", paire.publicKey));

  const cleNavigateur = await crypto.subtle.importKey(
    "raw", clePubliqueNavigateur, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: cleNavigateur }, paire.privateKey, 256));

  const sel = crypto.getRandomValues(new Uint8Array(16));

  const infoCle = coller(octets("WebPush: info\0"),
                         clePubliqueNavigateur, clePubliqueServeur);
  const ikm = await hkdf(partage, secretAuth, infoCle, 32);

  const cleContenu = await hkdf(ikm, sel, octets("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, sel, octets("Content-Encoding: nonce\0"), 12);

  const cleAes = await crypto.subtle.importKey("raw", cleContenu, "AES-GCM", false, ["encrypt"]);
  // 0x02 marque la fin du contenu : c'est le délimiteur de remplissage.
  const clair = coller(octets(message), new Uint8Array([0x02]));
  const chiffre = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, cleAes, clair));

  const entete = new Uint8Array(5);
  new DataView(entete.buffer).setUint32(0, 4096);   // taille d'enregistrement
  entete[4] = clePubliqueServeur.length;            // 65
  return coller(sel, entete, clePubliqueServeur, chiffre);
}

/** Jeton signé prouvant l'identité du serveur émetteur. */
async function jetonVapid(env, audience) {
  const { kty, crv, x, y, d } = JSON.parse(env.VAPID_JWK);
  const cle = await crypto.subtle.importKey(
    "jwk", { kty, crv, x, y, d, ext: true, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const entete = b64url(octets(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const charge = b64url(octets(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.CONTACT || "mailto:contact@brief.local",
  })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, cle, octets(`${entete}.${charge}`));
  return `${entete}.${charge}.${b64url(signature)}`;
}

async function envoyerPush(env, abonne, contenu) {
  const corps = await chiffrer(abonne.p256dh, abonne.auth, JSON.stringify(contenu));
  const jwt = await jetonVapid(env, new URL(abonne.endpoint).origin);

  return fetch(abonne.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "normal",
    },
    body: corps,
  });
}

/**
 * Variante tolérante de `majLots`, pour la diffusion seule.
 *
 * Marquer un abonnement périmé ou horodater une notification sont des à-côtés :
 * leur échec ne doit pas interrompre un envoi déjà parti vers les autres
 * abonnés. Il part en revanche dans les journaux Cloudflare, jamais dans le
 * silence. La publication, elle, utilise `majLots` et s'arrête net.
 */
async function majLot(env, table, lignes) {
  for (let i = 0; i < lignes.length; i += 10) {
    await tolerer(airtable(env, table, {}, {
      method: "PATCH",
      body: { records: lignes.slice(i, i + 10), typecast: true },
    }), `mise à jour de ${table}`);
  }
}

async function diffuser(requete, env) {
  if (!env.DIFFUSION_SECRET ||
      requete.headers.get("X-Diffusion") !== env.DIFFUSION_SECRET) {
    throw erreur("Diffusion non autorisée", 401);
  }
  if (!env.VAPID_JWK || !env.VAPID_PUBLIC) {
    throw erreur("Clés VAPID non configurées : VAPID_JWK et VAPID_PUBLIC.", 500);
  }

  const demande = await requete.json().catch(() => ({}));

  const trouvees = await tout(env, "editions", demande.slug
    ? { filterByFormula: `{Slug} = '${echapper(demande.slug)}'`, maxRecords: 1 }
    : { filterByFormula: "{Statut} = 'Publiée'", maxRecords: 1,
        "sort[0][field]": "Date", "sort[0][direction]": "desc" });
  if (!trouvees.length) throw erreur("Aucune édition à annoncer", 404);

  const ed = trouvees[0].fields;
  if (ed["Notification envoyée"] && !demande.forcer) {
    return json({ ignore: "notification déjà envoyée pour cette édition",
                  edition: ed["Slug"] });
  }

  const reglagesLus = Object.fromEntries((await tout(env, "reglages"))
    .filter(r => r.fields["Clé"])
    .map(r => [r.fields["Clé"], (r.fields["Valeur"] || "").trim()]));

  const contenu = {
    titre: demande.titre || reglagesLus.notification_titre
           || "Votre brief du soir est arrivé",
    corps: demande.corps || ed["Résumé"] || ed["Titre"] || "",
    slug: ed["Slug"] || ed["Date"],
  };

  const abonnes = (await tout(env, "push", { filterByFormula: "{Active}" }))
    .filter(r => r.fields["Endpoint"] && r.fields["Clé p256dh"] && r.fields["Clé auth"]);

  let envoyes = 0, expires = 0, echecs = 0;
  const perimes = [], servis = [];

  for (const a of abonnes) {
    try {
      const r = await envoyerPush(env, {
        endpoint: a.fields["Endpoint"],
        p256dh: a.fields["Clé p256dh"],
        auth: a.fields["Clé auth"],
      }, contenu);

      if (r.status === 404 || r.status === 410) {
        // Le navigateur a révoqué l'abonnement : inutile de le réessayer.
        expires++;
        perimes.push({ id: a.id, fields: { "Active": false } });
      } else if (r.ok) {
        envoyes++;
        servis.push({ id: a.id,
                      fields: { "Dernière notification": new Date().toISOString() } });
      } else {
        echecs++;
      }
    } catch { echecs++; }
  }

  if (perimes.length) await majLot(env, "push", perimes);
  if (servis.length) await majLot(env, "push", servis);

  if (envoyes) {
    await majLot(env, "editions",
                 [{ id: trouvees[0].id, fields: { "Notification envoyée": true } }]);
  }

  return json({
    edition: contenu.slug,
    destinataires: abonnes.length,
    envoyes, expires, echecs,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Utilitaires
// ───────────────────────────────────────────────────────────────────────────

function erreur(message, statut) {
  const e = new Error(message);
  e.statut = statut;
  return e;
}

function json(donnees, statut = 200, entetes = {}) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { "Content-Type": "application/json; charset=utf-8", ...entetes },
  });
}

function enTeteOrigine(requete, env) {
  const origine = requete.headers.get("Origin") || "";
  const autorisees = (env.ORIGINES || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!autorisees.length) return "*";
  return autorisees.includes(origine) ? origine : autorisees[0];
}

function cors(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // X-Diffusion figure ici pour que `/publier` et `/diffuser` restent
    // appelables depuis un outil de test dans le navigateur. Sans lui, le vol
    // préliminaire refuse la requête avant même qu'elle atteigne la route, et
    // la panne ressemble à un secret invalide. Le secret reste seul juge.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Diffusion",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
              "août", "septembre", "octobre", "novembre", "décembre"];

function enFrancais(iso) {
  const d = new Date(iso + "T12:00:00");
  return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`;
}
