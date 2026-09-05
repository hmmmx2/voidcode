#!/usr/bin/env bash
# VoidCode AI — WSL2 toolchain bootstrap for the Phase 2 Spark pipeline.
#
# Deliberately requires NO root. `sudo` on this box prompts for a password, which
# cannot be supplied non-interactively, so the JDK is installed into $VC_HOME
# rather than via apt. Re-running is safe; every step is skipped if already done.
#
# Layout rationale (spec §2.6): the repository stays on /mnt/c so it can be edited
# from Windows, but the virtualenv, the JDK and ALL data live on the WSL ext4
# filesystem. Crossing the 9p boundary for data would dominate Spark's runtime.
#
#   usage:  bash setup_wsl_env.sh
set -euo pipefail

VC_HOME="${VC_HOME:-$HOME/.voidcode}"
VC_DATA="${VC_DATA:-$HOME/voidcode-data}"
JDK_VERSION=17
VENV="$VC_HOME/venv"
# Resolved from this script's own location so PYTHONPATH is correct regardless of
# the directory the caller invoked it from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse every argument, not just $1. Testing $1 in two separate branches made
# `--locked` and `--with-r` mutually exclusive: passing both silently skipped R.
WANT_LOCKED=0
WANT_R=0
for arg in "$@"; do
  case "$arg" in
    --locked)  WANT_LOCKED=1 ;;
    --with-r)  WANT_R=1 ;;
    -h|--help)
      echo "usage: bash setup_wsl_env.sh [--locked] [--with-r]"
      echo "  --locked   install pinned versions from features/requirements.lock.txt"
      echo "  --with-r   also provision a root-free R env for the IRT cross-check"
      exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

mkdir -p "$VC_HOME" "$VC_DATA"

# ── JDK ─────────────────────────────────────────────────────────────────────
if [ ! -x "$VC_HOME/jdk/bin/java" ]; then
  echo "==> installing Temurin JDK ${JDK_VERSION} into $VC_HOME/jdk"
  ARCH="$(uname -m)"; [ "$ARCH" = "aarch64" ] && ARCH="aarch64" || ARCH="x64"
  URL="https://api.adoptium.net/v3/binary/latest/${JDK_VERSION}/ga/linux/${ARCH}/jdk/hotspot/normal/eclipse"
  curl -fsSL --retry 3 -o "$VC_HOME/jdk.tar.gz" "$URL"
  mkdir -p "$VC_HOME/jdk"
  tar -xzf "$VC_HOME/jdk.tar.gz" -C "$VC_HOME/jdk" --strip-components=1
  rm -f "$VC_HOME/jdk.tar.gz"
else
  echo "==> JDK already present"
fi
export JAVA_HOME="$VC_HOME/jdk"
export PATH="$JAVA_HOME/bin:$PATH"
java -version 2>&1 | head -1

# ── virtualenv ──────────────────────────────────────────────────────────────
if [ ! -x "$VENV/bin/python" ]; then
  echo "==> creating venv at $VENV"
  python3 -m venv "$VENV"
fi
# setuptools is NOT optional and must come first. Python 3.12 removed `distutils`
# from the stdlib and no longer seeds setuptools into new venvs, so without it
# `import distutils` fails and pyspark 3.5.3's ml/image.py drags that failure into
# `pyspark.ml.clustering` — KMeans and GaussianMixture become unimportable.
# `pyspark.ml.fpm` and `pyspark.ml.evaluation` are unaffected, which is why this
# stays invisible until you reach the clustering work.
"$VENV/bin/python" -m pip install --quiet --upgrade pip wheel setuptools

# `--locked` reinstalls the exact versions a known-good run resolved to, recorded
# in features/requirements.lock.txt. Only pyspark is pinned by default: leaving the
# rest floating is how pandas silently jumped to 3.0 mid-project, which is fine
# when it is verified but not something to discover after a number changes.
if [ "$WANT_LOCKED" = "1" ] && [ -f "$REPO_ROOT/features/requirements.lock.txt" ]; then
  echo "==> installing python packages from lockfile"
  "$VENV/bin/python" -m pip install --quiet -r "$REPO_ROOT/features/requirements.lock.txt"
else
  echo "==> installing python packages"
  "$VENV/bin/python" -m pip install --quiet \
    "pyspark==3.5.3" pyarrow pandas numpy scipy pyyaml requests \
    lightgbm scikit-learn matplotlib pandera pytest ruff tqdm
fi

# ── optional: root-free R for the IRT cross-validation (spec §4.3b) ─────────
# Opt-in because it is a ~450 MB download and the highest solve-failure risk in
# the toolchain. analysis/irt_validation.R's primary check is base-R only, so
# r-tam failing to solve degrades Check B to NOT RUN rather than breaking the run.
if [ "$WANT_R" = "1" ]; then
  MAMBA="$(command -v micromamba || echo "$HOME/bin/micromamba")"
  if [ -x "$MAMBA" ]; then
    echo "==> creating R environment (conda-forge, no root)"
    # Floor, not a pin: conda-forge resolves the current 4.x (observed 4.5.3).
    # analysis/irt_validation.R records the actual version via sessionInfo(), so the
    # reported figures always name the interpreter that produced them.
    "$MAMBA" create -y -p "$VC_HOME/menvs/voidcode-r" -c conda-forge "r-base>=4.4"
    # TAM first, mirt as fallback: Check B needs one independent MML estimator, not
    # a specific package. Check A is base-R only and runs regardless.
    "$MAMBA" install -y -p "$VC_HOME/menvs/voidcode-r" -c conda-forge r-tam \
      || "$MAMBA" install -y -p "$VC_HOME/menvs/voidcode-r" -c conda-forge r-mirt \
      || echo "WARNING: neither r-tam nor r-mirt solved; Check B will report NOT RUN"
  else
    echo "WARNING: micromamba not found; skipping R environment"
  fi
fi

# ── env file consumed by the Makefile and by spark-submit ───────────────────
cat > "$VC_HOME/env.sh" <<EOF
export JAVA_HOME="$VC_HOME/jdk"
export PATH="\$JAVA_HOME/bin:$VENV/bin:\$PATH"
export VC_DATA="$VC_DATA"
export PYSPARK_PYTHON="$VENV/bin/python"
export PYSPARK_DRIVER_PYTHON="$VENV/bin/python"

# Warehouses. warehouse_train/ holds features rebuilt with a pre-cutoff window so
# Phase 3 ranking features cannot see post-cutoff data (see ranking/split.py).
export VC_WAREHOUSE="\$VC_DATA/warehouse"
export VC_WAREHOUSE_TRAIN="\$VC_DATA/warehouse_train"

# Hive metastore. Derby lives as a SIBLING of warehouse/, never a child, because
# \`make clean-warehouse\` does rm -rf on warehouse/ and would take the metastore
# with it. Derby is also single-writer: never run two Spark sessions at once.
export VC_METASTORE="\$VC_DATA/metastore_db"
export VC_HIVE_WAREHOUSE="\$VC_DATA/hive_warehouse"

# MUST be exported, not left to the argparse default in build_features.py.
# learner_id = sha256(handle + salt), so a shell that sets this and one that does
# not produce two warehouses whose ids differ, and every join between them then
# silently returns fewer rows instead of failing.
export VC_SALT="\${VC_SALT:-voidcode-dev-salt}"

export SPARK_LOCAL_DIRS="\$VC_DATA/spark-tmp"
export VC_RSCRIPT="$VC_HOME/menvs/voidcode-r/bin/Rscript"
export PYTHONPATH="$REPO_ROOT\${PYTHONPATH:+:\$PYTHONPATH}"
EOF

mkdir -p "$VC_DATA/spark-tmp"

echo "==> verifying"
# shellcheck disable=SC1090
source "$VC_HOME/env.sh"
"$VENV/bin/python" - <<'PY'
import sys
mods = [
    ("pyspark", "pyspark"),
    ("pyspark.ml.clustering", None),   # the setuptools/distutils canary
    ("pyspark.ml.fpm", None),
    ("pyspark.ml.evaluation", None),
    ("numpy", "numpy"), ("pandas", "pandas"), ("scipy", "scipy"),
    ("lightgbm", "lightgbm"), ("sklearn", "sklearn"),
    ("matplotlib", "matplotlib"), ("pandera", "pandera"), ("pytest", "pytest"),
]
failed = []
for name, ver_of in mods:
    try:
        m = __import__(name, fromlist=["__version__"])
        v = getattr(__import__(ver_of), "__version__", "") if ver_of else ""
        print(f"  OK   {name:26s} {v}")
    except Exception as e:                                    # noqa: BLE001
        failed.append(f"{name}: {type(e).__name__}: {e}")
        print(f"  FAIL {name:26s} {type(e).__name__}: {e}")
if failed:
    print("\nENVIRONMENT INCOMPLETE:", *failed, sep="\n  ")
    sys.exit(1)
print(f"\npython {sys.version.split()[0]}")
PY

echo
echo "READY. Source the environment with:  source $VC_HOME/env.sh"
echo "Data root: $VC_DATA"
df -h "$VC_DATA" | tail -1
