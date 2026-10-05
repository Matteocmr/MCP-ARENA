# Pont MCP Obside Signals → cubrik.ai

Serveur MCP **en lecture seule** qui lit les signaux de l'arène Obside
(**Mistral Medium News** et **Kimi K2T News**) et les met à disposition de cubrik.

- Ne passe **aucun ordre**.
- La clé Obside reste dans les variables secrètes de Vercel : cubrik ne la voit jamais.
- cubrik s'authentifie avec un jeton séparé (`MCP_ACCESS_TOKEN`).

## Outils exposés à cubrik

| Outil | Rôle |
|---|---|
| `list_sources` | Catalogue Obside + vérifie que Mistral et Kimi sont bien trouvés |
| `get_recent_signals` | Signaux des X dernières heures (une source ou les deux) |
| `get_signals` | Lecture page par page avec curseur (`beginning`, `now`, ou `next_cursor`) |
| `get_source_state` | Trades ouverts, ordres en attente, poids actuels d'une source |
| `get_consensus` | Actifs où Mistral et Kimi sont dans le même sens / en conflit |
| `get_exit_profile` | SL / TP **implicites** : reconstitue les trades fermés (30 j), mesure gains, pertes, MAE/MFE avec l'historique de prix, et propose des niveaux pour les positions ouvertes |
| `inspect_fields` | Diagnostic : tous les champs réellement envoyés par Obside |

### À propos des SL / TP

Obside ne publie pas de stop-loss ni de take-profit : les modèles de l'Arène ouvrent et ferment au marché.
`get_exit_profile` les déduit du comportement passé de chaque modèle :

- **SL implicite** = le plus large entre le 90e percentile du pire écart subi par les trades gagnants et la perte médiane (pour ne pas couper des trades que le modèle aurait gagnés).
- **TP implicite** = gain médian encaissé sur les trades gagnants.
- Calcul par actif dès 8 trades, sinon global. Le champ `reliability` indique si l'échantillon est suffisant.

Prix historiques publics, sans clé : Binance (crypto) et Yahoo Finance (indices, or, forex, actions).
Si un actif n'est pas reconnu, il apparaît dans `skipped` ; on peut forcer la correspondance avec la variable
`PRICE_SYMBOL_MAP`, par ex. `{"US500":"^GSPC","GOLD":"GC=F"}`.

## Variables d'environnement (à saisir dans Vercel, jamais dans le code)

| Nom | Obligatoire | Description |
|---|---|---|
| `OBSIDE_SIGNALS_TOKEN` | oui | Clé créée dans Obside → Paramètres → Notifications → Clés API des signaux |
| `MCP_ACCESS_TOKEN` | oui | Mot de passe long et aléatoire (40+ caractères) que tu colleras aussi dans cubrik |
| `MISTRAL_SOURCE_ID` | non | Identifiant exact si la détection automatique par nom échoue |
| `KIMI_SOURCE_ID` | non | Idem pour Kimi |
| `OBSIDE_API_BASE` | non | Par défaut `https://api.obside.com/v1` |

## Déploiement sur Vercel (gratuit, plan Hobby)

1. Mets ce dossier dans un dépôt GitHub **privé** (sur github.com : New repository → Private → « uploading an existing file » → glisse tous les fichiers sauf `node_modules`).
2. Sur vercel.com : **Add New → Project** → importe ce dépôt → laisse les réglages par défaut.
3. Avant de cliquer sur Deploy, ouvre **Environment Variables** et ajoute `OBSIDE_SIGNALS_TOKEN` et `MCP_ACCESS_TOKEN`.
4. **Deploy**. Vérifie `https://<ton-projet>.vercel.app/health` : tu dois voir `"obside_token": true, "access_token": true`.

## Connexion dans cubrik

MCP → Ajouter un connecteur personnalisé :
- **Nom** : Obside Signals
- **URL** : `https://<ton-projet>.vercel.app/mcp`
- **Jeton d'accès** : la valeur de `MCP_ACCESS_TOKEN`

Puis demande à l'agent cubrik : « Appelle list_sources et dis-moi quelles sources sont trouvées ».

## Arrêter / reprendre

- Couper l'accès de cubrik : supprimer le connecteur dans cubrik, ou changer `MCP_ACCESS_TOKEN` dans Vercel puis redéployer.
- Couper l'accès à Obside : révoquer la clé dans Obside → Clés API des signaux.
- Aucun processus ne tourne en continu : le serveur ne répond que quand cubrik l'appelle.

## Tests

`npm install && npm test` — 13 tests contre une fausse API Obside (aucun appel réel).
