# A stand-in for /usr/bin/security for the unit tests of security_cli.rs. The test writes it into a
# scratch folder after one line that sets `dir` (the folder of this fake keychain) and runs the
# store against it. Bash, `xxd`, `tr` and `wc`, all of macOS.
#
# It keeps one file of hex per item in $dir/items, logs every argument list to $dir/argv.log and
# every line it is given on stdin to $dir/stdin.log, and is told to misbehave by lines in
# $dir/mode: deny-find, fail-find, hang-find, slow-find, fail-add, drop-add (does nothing and
# says nothing, as `security -i` does for some failures), fail-delete.
#
# Like the real tool: `find-generic-password -w` prints the data as it is when it is printable
# ASCII and in hex otherwise, exit code 44 means no such item, `add-generic-password` without -U
# on an existing item exits 45, and `-i` runs the lines of stdin as commands.

mkdir -p "$dir/items"
printf '%s\n' "$*" >> "$dir/argv.log"

mode() { grep -qx "$1" "$dir/mode" 2>/dev/null; }

run_command() {
  local cmd=$1
  shift
  local svc="" acct="" hex="" apps="" update=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) svc=$2; shift ;;
      -a) acct=$2; shift ;;
      -X) hex=$2; shift ;;
      -T) apps="$apps $2"; shift ;;
      -U) update=1 ;;
      -w) ;;
      *) ;;
    esac
    shift
  done
  local file="$dir/items/${svc}__${acct}"
  case "$cmd" in
    find-generic-password)
      mode hang-find && exec sleep 30
      mode slow-find && sleep 1
      if mode deny-find; then
        echo "security: SecKeychainSearchCopyNext: User interaction is not allowed." >&2
        return 36
      fi
      if mode fail-find; then
        echo "security: boom" >&2
        return 1
      fi
      if [ ! -f "$file" ]; then
        echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
        return 44
      fi
      local unprintable
      unprintable=$(xxd -r -p "$file" | LC_ALL=C tr -d '[:print:]' | wc -c)
      if [ "$unprintable" -eq 0 ]; then
        xxd -r -p "$file"
        echo
      else
        cat "$file"
        echo
      fi
      ;;
    add-generic-password)
      mode drop-add && return 0
      if mode fail-add; then
        echo "add-generic-password: returned -25299" >&2
        return 45
      fi
      if [ -f "$file" ] && [ "$update" -eq 0 ]; then
        echo "security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain." >&2
        return 45
      fi
      printf '%s' "$hex" > "$file"
      printf '%s\n' "$apps" > "$file.acl"
      ;;
    delete-generic-password)
      if [ ! -f "$file" ]; then
        echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
        return 44
      fi
      if mode fail-delete; then
        echo "security: could not remove" >&2
        return 1
      fi
      rm -f "$file" "$file.acl"
      echo "password has been deleted."
      ;;
    *)
      echo "security: unknown command" >&2
      return 2
      ;;
  esac
}

if [ "$1" = "-i" ]; then
  rc=0
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$dir/stdin.log"
    eval "run_command $line"
    rc=$?
  done
  exit $rc
fi
run_command "$@"
exit $?
