# Consignes du projet

- Pousser toutes les modifications directement sur `main` (pas de branche ni de pull request), après commit.
- Incrémenter `CACHE_VERSION` dans `service-worker.js` à chaque modification de `index.html`.
- Interface ordinateur (`html.desk-v2`, écrans ≥ 1100 px avec souris) : couleur principale neutre graphite & argent. Toute nouvelle tuile, carte, pastille ou bouton doit s'harmoniser avec la barre latérale : utiliser les jetons `--v2-*` et `--rgb-accent` / `--rgb-neutral` (redéfinis en tons neutres sur ordinateur), pas de bleu, cyan ou violet codé en dur. Vert (vu), orange (à compléter) et rouge (suppression) gardent leur sens ; les formats gardent leurs couleurs (4K bleu, Blu-ray violet, DVD orange).
- Les changements demandés pour l'ordinateur ne doivent rien modifier sur téléphone (ni sur iPad) : les limiter à `html.desk-v2` et vérifier l'absence d'effet sur mobile.
