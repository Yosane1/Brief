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
  if (chemin === "/reglages" && methode === "GET") return reglages(env);
  if (chemin === "/connexion" && methode === "POST") return connexion(requete, env);
  if (chemin === "/" && methode === "GET") {
    return json({ service: "brief", etat: "ok" });
  }

  // — Routes authentifiées ————————————————————————————————————————
  const session = await verifierSession(requete, env);

  switch (chemin + " " + methode) {
    case "/editions GET":    return editions(env);
    case "/edition GET":     return edition(env, url.searchParams.get("slug"));
    case "/articles GET":    return articles(env, url.searchParams);
    case "/vivier GET":      return vivier(env);
    case "/journal POST":    return journal(requete, env, session);
    case "/abonnement POST": return abonnement(requete, env, session);
  }
  throw erreur(`Route inconnue : ${methode} ${chemin}`, 404);
}

// ───────────────────────────────────────────────────────────────────────────
// Airtable — jamais exposé tel quel au navigateur
// ───────────────────────────────────────────────────────────────────────────

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
  const { jeton = "", appareil = "" } = await requete.json().catch(() => ({}));
  const propre = String(jeton).trim().toUpperCase();
  if (!propre) throw erreur("Saisissez un jeton d'accès.", 400);

  const trouves = await tout(env, "clients", {
    filterByFormula: `UPPER(TRIM({Jeton})) = '${echapper(propre)}'`,
    maxRecords: 1,
  });

  // Message volontairement identique à celui d'un jeton inexistant : inutile
  // de confirmer à un inconnu qu'un jeton donné existe.
  if (!trouves.length) {
    await tracer(env, null, propre, "Échec connexion", "Jeton inconnu", appareil);
    throw erreur("Ce jeton n'existe pas. Vérifiez la saisie.", 403);
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

  if (refus) {
    await tracer(env, trouves[0].id, propre, "Échec connexion", refus, appareil);
    throw erreur(refus, 403);
  }

  // Limite de postes, pour les abonnements non illimités.
  const places = f["Places"] || 0;
  if (!f["Utilisateurs illimités"] && places > 0 && appareil) {
    const passages = await tout(env, "journal", {
      filterByFormula: `AND({Jeton saisi} = '${echapper(propre)}', {Type} = 'Connexion')`,
      "fields[]": ["Appareil"],
    });
    const connus = new Set(passages.map(r => r.fields["Appareil"]).filter(Boolean));
    if (!connus.has(appareil) && connus.size >= places) {
      const motif = `Cet abonnement autorise ${places} appareil(s) et la limite est atteinte.`;
      await tracer(env, trouves[0].id, propre, "Échec connexion", motif, appareil);
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
  };

  const maintenant = Math.floor(Date.now() / 1000);
  const session = await signer(env, {
    c: trouves[0].id,
    n: nom,
    exp: maintenant + DUREE_SESSION,
  });

  await airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: trouves[0].id, fields: {
      "Dernière connexion": new Date().toISOString(),
      "Connexions": (f["Connexions"] || 0) + 1,
    }}], typecast: true },
  }).catch(() => {});

  await tracer(env, trouves[0].id, propre, "Connexion", appareil, appareil);

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
    "fields[]": ["Titre", "Rubrique", "Thématique", "Mots-clés", "Date", "Chapô"],
    "sort[0][field]": "Date",
    "sort[0][direction]": "desc",
  });
  return json(recs.map(article));
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
    motsCles: (f["Mots-clés"] || "").split(",").map(s => s.trim()).filter(Boolean),
    date: f["Date"] || "",
    ordre: f["Ordre"] || 0,
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

async function abonnement(requete, env, session) {
  const { appareil = "", active = true, description = "" } =
    await requete.json().catch(() => ({}));
  if (!appareil) throw erreur("Identifiant d'appareil manquant", 400);

  const champs = {
    "Identifiant": appareil,
    "Client": [session.c],
    "Appareil": description.slice(0, 200),
    "Active": !!active,
    "Créé le": new Date().toISOString(),
  };
  const existants = await tout(env, "push", {
    filterByFormula: `{Identifiant} = '${echapper(appareil)}'`, maxRecords: 1,
  });

  await airtable(env, "push", {}, existants.length
    ? { method: "PATCH", body: { records: [{ id: existants[0].id, fields: champs }], typecast: true } }
    : { method: "POST",  body: { records: [{ fields: champs }], typecast: true } });

  await airtable(env, "clients", {}, {
    method: "PATCH",
    body: { records: [{ id: session.c, fields: { "Notifications": !!active } }], typecast: true },
  }).catch(() => {});

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
  return airtable(env, "journal", {}, {
    method: "POST", body: { records: [{ fields: champs }], typecast: true },
  }).catch(() => {});   // le journal ne doit jamais empêcher la lecture
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
