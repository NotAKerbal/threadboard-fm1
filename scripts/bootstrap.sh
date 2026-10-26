#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
PIN=934e40d846d84e76e9c428d37b74bccb6192c823
if [ ! -d vendor/fm1-base/.git ]; then
  mkdir -p vendor
  git clone https://github.com/charlesvestal/fm1-base.git vendor/fm1-base
  git -C vendor/fm1-base checkout "$PIN"
fi
test "$(git -C vendor/fm1-base rev-parse HEAD)" = "$PIN" || { echo 'Unexpected fm1-base revision' >&2; exit 1; }
git -C vendor/fm1-base submodule update --init --recursive
test "$(git -C vendor/fm1-base/bsp rev-parse HEAD)" = 2cd696a2b94341077303e9132bb4be3d0a87ebcf || { echo 'Unexpected felucca-bsp revision' >&2; exit 1; }
mkdir -p .cache/ac79-sdk/cpu/wl82/tools/cfg
SDK=https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK/raw/d179b4484759423312073f5fbb232501aa491047/cpu/wl82/tools
get_sdk() {
  file="$1"; hash="$2"
  target=".cache/ac79-sdk/cpu/wl82/tools/$file"
  [ -f "$target" ] || curl -fL --retry 2 "$SDK/$file" -o "$target"
  actual="$(shasum -a 256 "$target" | cut -d ' ' -f 1)"
  test "$actual" = "$hash" || { echo "SDK checksum mismatch: $file" >&2; exit 1; }
}
get_sdk uboot.boot 4e3b4c220dc96641cb5a723f41e68ce41d5261ae9434bb33fbd7f2c59976ded4
get_sdk cfg_tool.bin 276579954f076886a6a7694f65dc71c034a63a2c204b76749065c0ac7b010d1b
get_sdk cfg/eq_cfg_hw.bin 41167491bffed4651750719c973d2758adeb9021a5670d02d6a53c85ed80ea7d
fetch_checked() {
  url="$1"; target="$2"; hash="$3"
  [ -f "$target" ] || curl -fL --retry 2 "$url" -o "$target"
  test "$(shasum -a 256 "$target" | cut -d ' ' -f 1)" = "$hash" || { echo "Checksum mismatch: $target" >&2; exit 1; }
}
fetch_checked https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK/raw/d179b4484759423312073f5fbb232501aa491047/LICENSE .cache/ac79-sdk/LICENSE c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4
mkdir -p output
fetch_checked https://raw.githubusercontent.com/m-vave/fm1_open/4c7496daac04a95ff10d1afdcc8f9ead2dbabc41/sdk/firmware/FM-1_015.fwsc output/stock-FM-1_015.fwsc db1642b2b6fa5c2cccb11ffd13878068bb28601678d3644049f99dc40e7edb8a
[ -x .cache/jieli/toolchain/pi32v2/bin/clang ] || sh vendor/fm1-base/tools/get_toolchain.sh .cache/jieli
test "$(shasum -a 256 .cache/jieli/toolchain/pi32v2/bin/clang | cut -d ' ' -f 1)" = c45189ee624de0430deb0db02e6dce171fb5538e7fe323e3964dc8ac6236240f || { echo 'Unexpected JieLi compiler version' >&2; exit 1; }
test "$(shasum -a 256 .cache/jieli/toolchain/pi32v2/bin/ld | cut -d ' ' -f 1)" = fd61aff15616bb6f6b58fd2e9ede7af741c7bf05facb3e0cb3d3c9817c268fd9 || { echo 'Unexpected JieLi linker version' >&2; exit 1; }
npm ci --ignore-scripts --prefer-offline
sh scripts/build-midi.sh
node scripts/build-desktop.mjs
echo 'Build inputs ready. Install scripts/build-requirements.txt into your Python environment before building firmware.'
