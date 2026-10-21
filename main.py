"""Builds the data cache if needed, regenerates the Ghost Targets charts, then reminds how to start the site."""
import runpy
from pathlib import Path

import common

if __name__ == "__main__":
    common.OUT.mkdir(exist_ok=True)
    common.receivers_at_throw()
    runpy.run_path(str(Path(__file__).parent / "prototypes" / "ghost_targets.py"), run_name="__main__")
    print(f"\nCharts written to {common.OUT}/ — start the site with: python server.py")
