#!/usr/bin/env bash
# Télécharge les données du NFL Big Data Bowl (événement régional) dans data/ (~830 Mo).
set -euo pipefail
cd "$(dirname "$0")"
BASE=https://raw.githubusercontent.com/ThompsonJamesBliss/nfl-big-data-bowl-regional-event-data/main/data
mkdir -p data/tracking
for f in games plays players pffScoutingData; do
  curl -sSL --retry 3 -o "data/$f.csv" "$BASE/$f.csv"
done
tail -n +2 data/games.csv | cut -d, -f1 |
  xargs -P 16 -I{} curl -sSL --retry 3 -o "data/tracking/tracking_{}.csv" "$BASE/tracking/tracking_{}.csv"
echo "OK : $(ls data/tracking | wc -l) matchs dans data/tracking"
