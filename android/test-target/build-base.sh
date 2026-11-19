#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../bin"
OUT_APK="${1:-${BIN_DIR}/grokbot-native-base.apk}"
BUILD_TMP="/tmp/grokbot-test-target-$$"

SDK_ROOT="${ANDROID_HOME:-/Users/lianqishi/Library/Android/sdk}"
if [ ! -d "${SDK_ROOT}" ] && [ -d "/Volumes/ORICO/android/sdk" ]; then
  SDK_ROOT="/Volumes/ORICO/android/sdk"
fi
ANDROID_JAR="${SDK_ROOT}/platforms/android-36/android.jar"
AAPT2_BIN="${SDK_ROOT}/build-tools/36.0.0/aapt2"
D8_BIN="${SDK_ROOT}/build-tools/36.0.0/d8"

JAVAC_BIN="$(command -v javac || true)"
if [ -z "${JAVAC_BIN}" ] || [ ! -x "${JAVAC_BIN}" ]; then
  JAVAC_BIN="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac"
fi

mkdir -p "$(dirname "${OUT_APK}")" "${BUILD_TMP}/compiled_res" "${BUILD_TMP}/gen" "${BUILD_TMP}/classes" "${BUILD_TMP}/dex"
trap 'rm -rf "${BUILD_TMP}"' EXIT

"${AAPT2_BIN}" compile --dir "${SCRIPT_DIR}/res" -o "${BUILD_TMP}/compiled_res/res.flata"

"${AAPT2_BIN}" link \
  -I "${ANDROID_JAR}" \
  --manifest "${SCRIPT_DIR}/AndroidManifest.xml" \
  -R "${BUILD_TMP}/compiled_res/res.flata" \
  -A "${SCRIPT_DIR}/assets" \
  --java "${BUILD_TMP}/gen" \
  --auto-add-overlay \
  -o "${BUILD_TMP}/base-link.apk"

find "${SCRIPT_DIR}/src/main/java" "${BUILD_TMP}/gen" -name "*.java" > "${BUILD_TMP}/sources.txt"
"${JAVAC_BIN}" --release 17 -encoding UTF-8 -cp "${ANDROID_JAR}" -d "${BUILD_TMP}/classes" @"${BUILD_TMP}/sources.txt"

"${D8_BIN}" --min-api 26 --output "${BUILD_TMP}/dex" $(find "${BUILD_TMP}/classes" -name "*.class")

node --input-type=module - "${SCRIPT_DIR}/../patchers/signing.mjs" "${BUILD_TMP}/base-link.apk" "${BUILD_TMP}/dex/classes.dex" "${OUT_APK}" <<'EOF'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , signingPath, linkApkPath, classesDexPath, outApkPath] = process.argv;
const { readZip, createEntry, writeZip } = await import(pathToFileURL(signingPath).href);
const zip = readZip(fs.readFileSync(linkApkPath));
const entries = zip.entries.filter(e => e.name !== 'classes.dex');
entries.push(createEntry('classes.dex', fs.readFileSync(classesDexPath), { store: false }));
fs.writeFileSync(outApkPath, writeZip(entries));
EOF

echo "Generated base test APK: ${OUT_APK}"
