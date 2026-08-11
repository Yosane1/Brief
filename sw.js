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
const VERSION = "brief-v2";
const COQUILLE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icones/icone-192.png",
  "./icones/icone-512.png",
];

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
        noms.filter(n => n !== VERSION).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Les données ne sont jamais mises en cache : un brief périmé affiché comme
  // frais serait pire que pas de brief du tout.
  if (url.hostname === "api.airtable.com") return;
  if (e.request.method !== "GET") return;
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
