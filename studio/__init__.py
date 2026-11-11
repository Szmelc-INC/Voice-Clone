"""OmniVoice Voice Edit Studio - web UI for transcript-driven voice editing."""

import os
import sys

# Some distro builds ship a torchvision that does not match the installed torch
# (e.g. Arch python-torchvision-rocm vs python-pytorch-rocm), and transformers
# imports it eagerly. The studio never needs torchvision, so hide it before
# anything imports transformers. Set OMNIVOICE_STUDIO_TORCHVISION=1 to keep it.
if os.environ.get("OMNIVOICE_STUDIO_TORCHVISION") != "1":
    sys.modules.setdefault("torchvision", None)

__version__ = "0.1.0"
