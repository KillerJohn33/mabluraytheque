# Consignes du projet

- Pousser toutes les modifications directement sur `main` (pas de branche ni de pull request), après commit.
- Incrémenter `CACHE_VERSION` dans `service-worker.js` à chaque modification de `index.html`.
- Couleurs : téléphone ET ordinateur (`html.desk-v2`, écrans ≥ 1100 px avec souris) partagent la même gamme, le cyan du logo (`--rgb-accent` 34,211,238 en sombre / 8,145,178 en clair, bleu ciel en secondaire, panneaux teintés de cyan). Toute nouvelle tuile, carte, pastille ou bouton doit utiliser les jetons `--v2-*` et `--rgb-*` plutôt que des couleurs codées en dur, et s'harmoniser avec la barre latérale (ordinateur) et la barre de navigation (téléphone). Vert (vu), orange (à compléter) et rouge (suppression) gardent leur sens ; les formats gardent leurs couleurs. Pas de halo lumineux autour des boutons.
- Les changements demandés pour l'ordinateur ne doivent rien modifier sur téléphone (ni sur iPad) : les limiter à `html.desk-v2` et vérifier l'absence d'effet sur mobile.
