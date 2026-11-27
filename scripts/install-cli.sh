#!/usr/bin/env bash
# Installs the `rokbot` command: links bin/rokbot.mjs from a RokBot checkout into a bin directory.
#   Inside a checkout:   bash scripts/install-cli.sh
#   Fresh machine:       git clone https://github.com/hongfaqiu/rokbot.git ~/.rokbot/cli && bash ~/.rokbot/cli/scripts/install-cli.sh
# Environment: ROKBOT_CLI_DIR (checkout used when this script is not inside one, default ~/.rokbot/cli),
#              ROKBOT_BIN_DIR (where the link goes, default ~/.local/bin), ROKBOT_REPO_URL, ROKBOT_REF.
set -Eeuo pipefail

fail() { echo "安装失败：$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "需要 Node.js 20 或更新版本"
node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 20 )) || fail "需要 Node.js 20 或更新版本，当前为 $(node -v)"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd)"
repo_url="${ROKBOT_REPO_URL:-https://github.com/hongfaqiu/rokbot.git}"
if [[ -f "${script_dir}/../bin/rokbot.mjs" && -d "${script_dir}/cli" ]]; then
  checkout="$(cd -- "${script_dir}/.." && pwd)"
else
  checkout="${ROKBOT_CLI_DIR:-$HOME/.rokbot/cli}"
  command -v git >/dev/null 2>&1 || fail "需要 git"
  if [[ -d "${checkout}/.git" ]]; then
    git -C "$checkout" pull --ff-only
  else
    mkdir -p "$(dirname -- "$checkout")"
    git clone ${ROKBOT_REF:+--branch "$ROKBOT_REF"} "$repo_url" "$checkout"
  fi
fi
[[ -f "${checkout}/bin/rokbot.mjs" ]] || fail "${checkout} 中没有 bin/rokbot.mjs"
chmod +x "${checkout}/bin/rokbot.mjs"

bin_dir="${ROKBOT_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
target="${bin_dir}/rokbot"
if [[ -e "$target" && ! -L "$target" ]]; then
  fail "${target} 已存在且不是链接，不会覆盖"
fi
ln -sfn "${checkout}/bin/rokbot.mjs" "$target"

echo "已安装：${target} -> ${checkout}/bin/rokbot.mjs"
case ":${PATH}:" in
  *":${bin_dir}:"*) ;;
  *) echo "提示：${bin_dir} 不在 PATH 中，请把 export PATH=\"${bin_dir}:\$PATH\" 加到 shell 配置文件。" ;;
esac
echo "运行 rokbot --help 查看用法。"
