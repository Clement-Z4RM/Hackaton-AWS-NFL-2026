# Passes NFL : le receveur oublié

**Sur 7 090 passes NFL, 16 % ignorent un receveur seul à 5 yards ou plus. Il est seul depuis 1,1 s en médiane, et une fois sur deux le quarterback n'a jamais tourné les épaules vers lui.**

- **L'outil** rejoue chaque passe à partir du tracking (22 joueurs, 10 mesures/s), vue du dessus et **en 3D depuis les yeux du quarterback**, puis prolonge l'action jusqu'au résultat réel.
- **L'originalité** : un verdict « passe **possible / serrée / contestée** » pour **chaque receveur** (vol du ballon contre course du défenseur le plus rapide), pas seulement pour le plus libre.
- **La preuve** : quand le modèle dit « possible », la passe réelle est réussie à **79 %** ; quand il dit « contestée », à **57 %**.
- **Pour qui** : le coach revoit chaque décision de son quarterback option par option ; le commentateur l'explique en 3D, en un clic.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && ./download_data.sh && .venv/bin/python server.py   # puis http://localhost:5000
```

![Stafford vise Kupp (passe contestée) : interceptée. Henderson était seul, passe possible.](outputs/demo_interface.gif)

*Stafford vise Cooper Kupp (passe contestée, −0,7 s) : **interceptée**. Darrell Henderson était seul à 10 yards, passe possible (+0,7 s). Suite simulée après la fin des mesures, résultat réel.*

| La même action, vue par le quarterback | Tendances sur toutes les passes |
|---|---|
| ![Vue 3D depuis les yeux du quarterback](outputs/demo_vue_3d.gif) | ![Tendances](outputs/site_tendances.png) |

Autre enregistrements et capture de l'application:

https://drive.google.com/drive/folders/1le2V__tYpMyLDaUfBlPMzC9-OtdvAYjE?usp=sharing
