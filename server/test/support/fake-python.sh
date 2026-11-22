#!/bin/sh
# A stand-in Python for the toolkit tests: it records its arguments and answers what Prepare asks.
# Behaviour comes from the environment: FAKE_PYTHON_LOG (file that gets one line per call),
# FAKE_PYTHON_VERSION (default 3.12.4), FAKE_PYTHON_FAIL (venv, pipversion, pipupgrade, pip,
# doctor, speech).
log="${FAKE_PYTHON_LOG:-/dev/null}"
echo "$*" >> "$log"
fail="${FAKE_PYTHON_FAIL:-}"
version="${FAKE_PYTHON_VERSION:-3.12.4}"
case "$1" in
  -c)
    case "$2" in
      *sys.version_info*) echo "$version"; exit 0 ;;
      *snapshot_download*)
        [ "$fail" = "speech" ] && { echo "ConnectionError: offline" >&2; exit 1; }
        echo "VIDAI_MODEL mlx mlx-community/whisper-large-v3-mlx /cache/model"; exit 0 ;;
    esac ;;
  -m)
    case "$2" in
      venv)
        [ "$fail" = "venv" ] && { echo "Error: ensurepip is not available" >&2; exit 1; }
        shift 2
        [ "$1" = "--clear" ] && shift
        mkdir -p "$1/bin" && cp "$0" "$1/bin/python" && chmod +x "$1/bin/python"; exit 0 ;;
      pip)
        case "$3" in
          --version)
            [ "$fail" = "pipversion" ] && { echo "No module named pip" >&2; exit 1; }
            echo "pip 24.0 from /fake/lib/pip (python 3.12)"; exit 0 ;;
          install)
            case "$*" in
              *--upgrade*)
                [ "$fail" = "pipupgrade" ] && { echo "ERROR: cannot upgrade pip" >&2; exit 1; }
                echo "Successfully installed pip"; exit 0 ;;
            esac
            echo "Collecting numpy"
            [ "$fail" = "pip" ] && { echo "ERROR: No matching distribution found for numpy" >&2; exit 1; }
            echo "Successfully installed numpy"; exit 0 ;;
        esac ;;
    esac ;;
  *ve.py)
    if [ "$2" = "doctor" ]; then
      if [ "$fail" = "doctor" ]; then
        echo "ffmpeg   OK  /fake/ffmpeg"
        echo "speech   MISSING (mlx): No module named 'mlx_whisper'"
        echo "result: INCOMPLETE"; exit 1
      fi
      echo "ffmpeg   OK  /fake/ffmpeg"
      echo "xmllint  missing (optional: FCPXML is not validated)"
      echo "hardware videotoolbox (VE_HW picks another; none forces software)"
      echo "speech   OK  mlx, device gpu"
      echo "result: READY"; exit 0
    fi ;;
esac
echo "fake-python: unexpected arguments: $*" >&2
exit 2
