#!/bin/sh
set -eu

download_base="${AGENTPOOL_DOWNLOAD_BASE:-https://agentpool.itool.tech/downloads}"
install_directory="${AGENTPOOL_INSTALL_DIR:-${HOME}/.local/bin}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/agentpool-install.XXXXXX")"
temporary_binary="${temporary_directory}/agentpool"
temporary_checksum="${temporary_directory}/agentpool.sha256"

cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT INT TERM

if ! command -v node >/dev/null 2>&1; then
  echo "Agent Pool requires Node.js 20 or newer." >&2
  exit 1
fi

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "${node_major}" -lt 20 ]; then
  echo "Agent Pool requires Node.js 20 or newer." >&2
  exit 1
fi

curl -fsSL "${download_base}/agentpool" -o "${temporary_binary}"
curl -fsSL "${download_base}/agentpool.sha256" -o "${temporary_checksum}"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${temporary_directory}" && sha256sum -c agentpool.sha256 >/dev/null)
elif command -v shasum >/dev/null 2>&1; then
  expected_checksum="$(awk '{print $1}' "${temporary_checksum}")"
  actual_checksum="$(shasum -a 256 "${temporary_binary}" | awk '{print $1}')"
  if [ "${expected_checksum}" != "${actual_checksum}" ]; then
    echo "Agent Pool download checksum mismatch." >&2
    exit 1
  fi
else
  echo "A SHA-256 checksum tool is required (sha256sum or shasum)." >&2
  exit 1
fi

mkdir -p "${install_directory}"
chmod 755 "${temporary_binary}"
mv "${temporary_binary}" "${install_directory}/agentpool"

echo "Agent Pool installed at ${install_directory}/agentpool"
case ":${PATH}:" in
  *":${install_directory}:"*) ;;
  *) echo "Add ${install_directory} to PATH, then run: agentpool login" ;;
esac
