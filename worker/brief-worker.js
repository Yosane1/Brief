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
 *   Variables         BASE_ID           appzxFhyARS0LjDFc
 *                     ORIGINES          les origines autorisées, séparées par
 *                                       des virgules
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

  // Diffusion : appelée par le workflow de publication, jamais par un lecteur.
  // Elle s'authentifie par un secret partagé plutôt que par une session.
  if (chemin === "/diffuser" && methode === "POST") return diffuser(requete, env);

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
  return json({
    service: "brief",
    etat: pret ? "ok" : "configuration incomplète",
    config,
    airtable: airtableEtat,
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
    const detail = await r.text().catch(() => "");
    throw erreur(`Airtable ${r.status} : ${detail.slice(0, 160)}`, 502);
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
    // lequel de ses appareils.
    sujets: listeSujets(f["Sujets suivis"]),
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

/** Met à jour des enregistrements par lots de 10, la limite de l'API. */
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
