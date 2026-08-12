/* Service worker de Brief.
 *
 * Il rend trois services que la page seule ne peut pas rendre :
 *   1. l'installation en application autonome sur Android ;
 *   2. l'affichage des notifications — Chrome Android ignore purement et
 *      simplement `new Notification()`, seul `registration.showNotification()`
 *      fonctionne ;
 *   3. la lecture hors ligne du dernier brief consulté.
 */

// Incrémenter à chaque déploiement : l'activation purge les caches des versions
// précédentes.
const VERSION = "brief-v4";
const COQUILLE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icones/icone-192.png",
  "./icones/icone-512.png",
];

// Les briefs, dans un cache distinct de la coquille : ils survivent au
// déploiement d'une nouvelle version de l'application, et disparaissent à la
// déconnexion (la page les efface, un poste peut être partagé).
const DONNEES = "brief-donnees";

// La passerelle est sur une autre origine que l'application. C'est cette
// différence qui avait fait tomber la lecture hors ligne sans qu'on la voie :
// le filtre same-origin plus bas écartait toutes les données.
const PASSERELLE = "https://brief.jamet-aymeric-pro.workers.dev";

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(COQUILLE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // une icône manquante ne doit rien bloquer
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(
        noms.filter(n => n !== VERSION && n !== DONNEES).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  if (e.request.method !== "GET") return;

  // Airtable n'est plus joint directement depuis la page ; s'il l'était encore,
  // il ne faudrait pas conserver de jeton dans un cache.
  if (url.hostname === "api.airtable.com") return;

  // Les briefs. Réseau d'abord — une édition fraîche prime toujours — et cache
  // en dernier recours, ce qui rend le brief lisible dans le métro. La réponse
  // servie depuis le cache est datée pour que la page puisse le dire : un brief
  // d'avant-hier présenté comme celui du soir serait pire que pas de brief.
  if (url.origin === PASSERELLE) {
    e.respondWith(donneesReseauPuisCache(e.request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Le document et le manifeste sont demandés en contournant le cache HTTP du
  // navigateur. Sans cela, une page mise à jour peut rester invisible pendant
  // des heures — c'est particulièrement visible dans une application installée,
  // qui n'offre aucun moyen de forcer un rechargement.
  const toujoursFrais = e.request.mode === "navigate"
    || url.pathname.endsWith(".html")
    || url.pathname.endsWith(".webmanifest");

  // Réseau d'abord, cache en repli : une mise à jour de l'app est visible au
  // rechargement suivant, et l'app reste lisible hors ligne.
  e.respondWith(
    fetch(e.request, toujoursFrais ? { cache: "no-store" } : undefined)
      .then(rep => {
        if (rep && rep.ok) {
          const copie = rep.clone();
          caches.open(VERSION).then(c => c.put(e.request, copie));
        }
        return rep;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

/**
 * Les briefs : réseau d'abord, cache en repli.
 *
 * La réponse tirée du cache est reconstruite plutôt que renvoyée telle quelle,
 * pour lui ajouter `X-Brief-Cache`. Une réponse fabriquée ici n'est pas soumise
 * au filtrage CORS des en-têtes — la page peut donc lire cette date et prévenir
 * le lecteur qu'il consulte une version enregistrée.
 */
async function donneesReseauPuisCache(requete) {
  const cache = await caches.open(DONNEES);
  try {
    const rep = await fetch(requete);
    // Une erreur d'authentification ou un 500 n'ont rien à faire en cache : on
    // les laisse passer, mais la prochaine coupure doit retrouver le brief.
    if (rep.ok) cache.put(requete, rep.clone());
    return rep;
  } catch (panne) {
    const garde = await cache.match(requete);
    if (!garde) throw panne;

    const entetes = new Headers(garde.headers);
    entetes.set("X-Brief-Cache", garde.headers.get("date") || new Date().toUTCString());
    return new Response(await garde.arrayBuffer(), {
      status: 200,
      statusText: "OK (cache)",
      headers: entetes,
    });
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/* Déclenché par la page (postMessage) faute de serveur push : la vérification
 * « nouveau brief » se fait côté client. Le jour où un serveur signera des
 * envois VAPID, l'événement `push` ci-dessous prendra le relais sans que la
 * page change. */
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type !== "notifier") return;
  e.waitUntil(afficher(d.titre, d.corps, d.slug));
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  e.waitUntil(afficher(
    d.titre || "Votre brief du soir est arrivé",
    d.corps || "",
    d.slug || ""
  ));
});

function afficher(titre, corps, slug) {
  return self.registration.showNotification(titre, {
    body: corps,
    icon: "./icones/icone-192.png",
    badge: "./icones/icone-192.png",
    tag: "brief-" + (slug || "jour"),
    renotify: true,
    lang: "fr",
    data: { slug },
    actions: [{ action: "lire", title: "Lire le brief" }],
  });
}

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const slug = (e.notification.data && e.notification.data.slug) || "";
  const cible = new URL(
    "./index.html#/" + (slug ? "edition/" + slug : ""),
    self.location.origin + self.location.pathname.replace(/sw\.js$/, "")
  ).href;

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(fenetres => {
        for (const f of fenetres) {
          if (f.url.startsWith(self.location.origin)) {
            f.navigate(cible).catch(() => {});
            return f.focus();
          }
        }
        return self.clients.openWindow(cible);
      })
  );
});
