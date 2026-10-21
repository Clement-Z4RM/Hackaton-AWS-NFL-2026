# Passes NFL : le receveur oublié

Un outil qui rejoue chaque passe NFL à partir du tracking Next Gen Stats et dit, **pour chaque receveur, si la passe était possible**. NFL Big Data Bowl, Paris Side Quest (AWS × NFL, 21 octobre 2026).

> **16 % des 7 090 passes ignorent un receveur seul à 5 yards ou plus**, seul depuis 1,1 s en médiane. Une fois sur deux, le quarterback n'a même pas tourné les épaules vers lui.

![Stafford vise Kupp (passe contestée) : interceptée. Henderson était seul, passe possible.](outputs/demo_interface.gif)

## Fonctionnalités

| | |
|---|---|
| **Replay** | Les 22 joueurs à 10 images/s, ralenti, image par image ; suite simulée jusqu'au **résultat réel** |
| **Passe possible ?** | Pour chaque receveur : espace, temps seul, regard du lanceur, verdict possible / serrée / contestée |
| **Vue 3D** | L'action vue depuis les yeux du quarterback |
| **Calques** | Cône de regard, temps seul, zones de contrôle, zones d'oubli |
| **Tendances** | Receveurs les plus oubliés, quarterbacks, carte des oublis par équipe |
| **Import** | Glisser-déposer les CSV d'un match ; export de n'importe quelle action en GIF |

**Le modèle tient** : une passe jugée possible est réussie à **79 %**, une passe contestée à **57 %**.

## Démo

![Démonstration de l'application](assets/demo_application.gif)

*Vidéo d'origine en MP4 : [assets/demo_application.mp4](assets/demo_application.mp4) (téléchargement).*

| Vue 3D du quarterback | Tendances | Carte des oublis |
|---|---|---|
| ![Vue 3D](outputs/demo_vue_3d.gif) | ![Tendances](assets/page_tendances.png) | ![Carte des oublis](assets/carte_oublis.png) |

## Lancer

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./download_data.sh            # données des 122 matchs (~830 Mo)
.venv/bin/python server.py    # http://localhost:5000
```

Python 3.11+. Premier lancement : ~1 min de calcul, mis en cache dans `data/cache/`.

## Structure du dépôt

```
server.py         # Serveur Flask : API, import, chargement des extensions
backend.py        # Données d'une action, suite simulée
passing.py        # Modèle « la passe était-elle possible ? » + validation
common.py         # Chargement et normalisation des données
features/         # Extensions serveur : passes, temps seul, regard, carte, export GIF
web/              # Interface : index.html, style.css, app.js
  features/       # Extensions navigateur : vue 3D, regard, temps seul, zones, carte
prototypes/       # Première analyse et génération des GIF
outputs/          # GIF et captures du README
assets/           # Vidéo et captures de l'application
download_data.sh  # Télécharge les données dans data/ (ignoré par git)
```
