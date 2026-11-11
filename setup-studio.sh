#!/usr/bin/env bash
# Create a venv for the Voice Edit Studio that reuses the system torch build
# (e.g. Arch python-pytorch-rocm) instead of downloading a CUDA wheel.
#
#   ./setup-studio.sh [OMNIVOICE_DIR] [VENV_DIR]
#
# OMNIVOICE_DIR: k2-fsa/OmniVoice checkout (default: current directory)
# VENV_DIR:      venv to create (default: .venv-studio)
set -euo pipefail

OMNI="${1:-.}"
VENV="${2:-.venv-studio}"
PY="${PYTHON:-python3}"

if [ ! -f "$OMNI/omnivoice/__init__.py" ]; then
  echo "No OmniVoice checkout at '$OMNI' (expected $OMNI/omnivoice/)." >&2
  exit 1
fi
"$PY" -c "import torch" 2>/dev/null || {
  echo "System Python has no torch. Install your GPU's torch build first." >&2
  exit 1
}

uv venv --system-site-packages --python "$PY" "$VENV"
uv pip install --python "$VENV/bin/python" -r "$(dirname "$0")/requirements-studio.txt"

# Resolvers pull a CUDA torch for transformers/accelerate; it would shadow the
# system build, so remove anything torch-related that landed in the venv.
mapfile -t extra < <(uv pip list --python "$VENV/bin/python" --format freeze 2>/dev/null \
  | cut -d= -f1 | grep -iE '^(torch|triton|nvidia-.*|cuda-.*)$' || true)
if [ "${#extra[@]}" -gt 0 ]; then
  uv pip uninstall --python "$VENV/bin/python" "${extra[@]}"
fi

uv pip install --python "$VENV/bin/python" --no-deps -e "$OMNI"

"$VENV/bin/python" - <<'EOF'
import sys
sys.modules["torchvision"] = None  # same guard the studio uses
import torch, transformers
from omnivoice import OmniVoice
print(f"torch {torch.__version__} (GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'}), "
      f"transformers {transformers.__version__}: OK")
EOF
echo "Run: $VENV/bin/python -m studio --open"
