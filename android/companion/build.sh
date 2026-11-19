#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/../bin"
STUBS_SRC="${SCRIPT_DIR}/compile-stubs/src/main/java"
SRC_DIR="${SCRIPT_DIR}/src/main/java"
BUILD_TMP="${TMPDIR:-$COMPANION_DIR/.build-tmp}-$$"

ANDROID_JAR="${ANDROID_HOME:-/Users/lianqishi/Library/Android/sdk}/platforms/android-36/android.jar"
if [ ! -f "${ANDROID_JAR}" ]; then
  ANDROID_JAR="/Volumes/ORICO/android/sdk/platforms/android-36/android.jar"
fi

D8_BIN="${ANDROID_HOME:-/Users/lianqishi/Library/Android/sdk}/build-tools/36.0.0/d8"
if [ ! -f "${D8_BIN}" ]; then
  D8_BIN="/Volumes/ORICO/android/sdk/build-tools/36.0.0/d8"
fi

JAVAC_BIN="$(command -v javac || true)"
if [ -z "${JAVAC_BIN}" ] || [ ! -x "${JAVAC_BIN}" ]; then
  JAVAC_BIN="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac"
fi
JAR_BIN="$(command -v jar || true)"
if [ -z "${JAR_BIN}" ] || [ ! -x "${JAR_BIN}" ]; then
  JAR_BIN="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/jar"
fi

mkdir -p "${BIN_DIR}" "${BUILD_TMP}/stubs" "${BUILD_TMP}/classes"
trap 'rm -rf "${BUILD_TMP}"' EXIT

# 1. Compile compile-time-only stubs to stubs.jar (NEVER packaged into classes2.dex)
find "${STUBS_SRC}" -name "*.java" > "${BUILD_TMP}/stub_sources.txt"
"${JAVAC_BIN}" --release 17 -encoding UTF-8 -cp "${ANDROID_JAR}" -d "${BUILD_TMP}/stubs" @"${BUILD_TMP}/stub_sources.txt"
"${JAR_BIN}" cf "${BUILD_TMP}/stubs.jar" -C "${BUILD_TMP}/stubs" .

# 2. Compile companion native classes against android.jar + stubs.jar
find "${SRC_DIR}" -name "*.java" > "${BUILD_TMP}/sources.txt"
"${JAVAC_BIN}" --release 17 -encoding UTF-8 -cp "${ANDROID_JAR}:${BUILD_TMP}/stubs.jar" -d "${BUILD_TMP}/classes" @"${BUILD_TMP}/sources.txt"

# 3. Dex ONLY dev.grokbot.nativeapp classes into bin/classes2.dex
"${D8_BIN}" --min-api 26 --output "${BUILD_TMP}/" $(find "${BUILD_TMP}/classes" -name "*.class")

cp "${BUILD_TMP}/classes.dex" "${BIN_DIR}/classes2.dex"
echo "Generated ${BIN_DIR}/classes2.dex"
